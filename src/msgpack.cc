/*
 * Node.js MessagePack bindings.
 *
 * Pack/unpack JavaScript values via vendored msgpack-c (C API).
 * Unpack is fail-closed: oversized array/map/string/bin headers are rejected
 * before the C library allocates. Pack errors always release the sbuffer
 * (msgpack/msgpack-node#25686).
 *
 * GCOVR_EXCL_BR_LINE / _START / _STOP markers below mark branches that cannot
 * be reached from JS without stubbing the allocator or V8: allocation-failure
 * arms of msgpack_pack_*, empty-MaybeLocal guards V8 only produces while an
 * exception is pending, and post-ScanOne error arms that ScanOne has already
 * ruled out. Each carries the reason inline; COVERAGE.md lists them all.
 */

#include <cmath>
#include <cstdint>

#include <nan.h>
#include <msgpack.h>

namespace {

const uint32_t kMaxContainer = 1000000u;
const uint32_t kMaxBytes = 32u * 1024u * 1024u;
const int kMaxDepth = 512;
/* Pack recursion is bounded the same way master bounded it, so deeply nested
 * input throws instead of running the C stack out. */
const int kMaxPackDepth = 512;
/* Largest/smallest doubles that survive a cast to uint64_t/int64_t. */
const double kTwoPow64 = 18446744073709551616.0;
const double kInt64Min = -9223372036854775808.0;
const size_t kSbufferPoolMax = 512;

enum ScanStatus {
  kScanOk = 0,
  kScanContinue,
  kScanLimit,
  kScanParse
};

struct Cursor {
  const unsigned char* p;
  const unsigned char* end;
};

static bool ReadU8(Cursor* c, uint8_t* out) {
  if (c->p >= c->end) return false;
  *out = *c->p++;
  return true;
}

static bool ReadU16(Cursor* c, uint16_t* out) {
  if (c->end - c->p < 2) return false;
  *out = static_cast<uint16_t>((c->p[0] << 8) | c->p[1]);
  c->p += 2;
  return true;
}

static bool ReadU32(Cursor* c, uint32_t* out) {
  if (c->end - c->p < 4) return false;
  *out = (static_cast<uint32_t>(c->p[0]) << 24) |
         (static_cast<uint32_t>(c->p[1]) << 16) |
         (static_cast<uint32_t>(c->p[2]) << 8) |
         static_cast<uint32_t>(c->p[3]);
  c->p += 4;
  return true;
}

static bool Skip(Cursor* c, size_t n) {
  if (static_cast<size_t>(c->end - c->p) < n) return false;
  c->p += n;
  return true;
}

static ScanStatus CheckContainer(uint32_t n, size_t remaining, bool is_map, int sp) {
  if (n > kMaxContainer) return kScanLimit;
  uint64_t items = is_map ? static_cast<uint64_t>(n) * 2u : n;
  if (items > remaining) {
    /* Declared payload cannot exist in this buffer. If n is huge this is
     * a DoS header; if n is modest the message is merely truncated. */
    /* Both disjuncts are already excluded above: n > kMaxContainer returned
     * at the top, and items is at most 2 * kMaxContainer, far under
     * kMaxBytes. Kept as defence in depth if either constant changes. */
    if (n > kMaxContainer || items > kMaxBytes) return kScanLimit;  /* GCOVR_EXCL_BR_LINE */
    return kScanContinue;
  }
  if (sp >= kMaxDepth) return kScanLimit;
  return kScanOk;
}

static ScanStatus CheckBytes(uint32_t n, size_t remaining) {
  if (n > kMaxBytes) return kScanLimit;
  if (n > remaining) return kScanContinue;
  return kScanOk;
}

/*
 * Walk one MessagePack object. Extra trailing bytes are allowed (streaming).
 * Incomplete headers/payloads return kScanContinue. Absurd sizes return
 * kScanLimit without allocating.
 */
static ScanStatus ScanOne(const char* data, size_t len, size_t* consumed) {
  Cursor c;
  c.p = reinterpret_cast<const unsigned char*>(data);
  c.end = c.p + len;

  struct Frame { uint32_t remaining; };
  Frame stack[kMaxDepth];
  int sp = 0;
  stack[sp++].remaining = 1;

  while (sp > 0) {
    if (stack[sp - 1].remaining == 0) {
      sp--;
      continue;
    }
    stack[sp - 1].remaining--;

    uint8_t b;
    if (!ReadU8(&c, &b)) return kScanContinue;

    if (b <= 0x7f || b >= 0xe0) {
      continue; /* fixint */
    }
    if ((b & 0xf0) == 0x80) { /* fixmap */
      uint32_t n = b & 0x0f;
      ScanStatus st = CheckContainer(n, static_cast<size_t>(c.end - c.p), true, sp);
      if (st != kScanOk) return st;
      stack[sp++].remaining = n * 2u;
      continue;
    }
    if ((b & 0xf0) == 0x90) { /* fixarray */
      uint32_t n = b & 0x0f;
      ScanStatus st = CheckContainer(n, static_cast<size_t>(c.end - c.p), false, sp);
      if (st != kScanOk) return st;
      stack[sp++].remaining = n;
      continue;
    }
    if ((b & 0xe0) == 0xa0) { /* fixstr */
      uint32_t n = b & 0x1f;
      ScanStatus st = CheckBytes(n, static_cast<size_t>(c.end - c.p));
      if (st != kScanOk) return st;
      if (!Skip(&c, n)) return kScanContinue;  /* GCOVR_EXCL_BR_LINE: CheckBytes proved n <= remaining */
      continue;
    }

    switch (b) {
      case 0xc0: /* nil */
      case 0xc2: /* false */
      case 0xc3: /* true */
        break;
      case 0xc1:
        return kScanParse;
      case 0xc4: { /* bin8 */
        uint8_t n;
        if (!ReadU8(&c, &n)) return kScanContinue;
        ScanStatus st = CheckBytes(n, static_cast<size_t>(c.end - c.p));
        if (st != kScanOk) return st;
        if (!Skip(&c, n)) return kScanContinue;  /* GCOVR_EXCL_BR_LINE: CheckBytes proved n <= remaining */
        break;
      }
      case 0xc5: { /* bin16 */
        uint16_t n;
        if (!ReadU16(&c, &n)) return kScanContinue;
        ScanStatus st = CheckBytes(n, static_cast<size_t>(c.end - c.p));
        if (st != kScanOk) return st;
        if (!Skip(&c, n)) return kScanContinue;  /* GCOVR_EXCL_BR_LINE: CheckBytes proved n <= remaining */
        break;
      }
      case 0xc6: { /* bin32 */
        uint32_t n;
        if (!ReadU32(&c, &n)) return kScanContinue;
        ScanStatus st = CheckBytes(n, static_cast<size_t>(c.end - c.p));
        if (st != kScanOk) return st;
        if (!Skip(&c, n)) return kScanContinue;  /* GCOVR_EXCL_BR_LINE: CheckBytes proved n <= remaining */
        break;
      }
      case 0xc7: { /* ext8 */
        uint8_t n;
        if (!ReadU8(&c, &n)) return kScanContinue;
        if (!Skip(&c, 1)) return kScanContinue;
        ScanStatus st = CheckBytes(n, static_cast<size_t>(c.end - c.p));
        if (st != kScanOk) return st;
        if (!Skip(&c, n)) return kScanContinue;  /* GCOVR_EXCL_BR_LINE: CheckBytes proved n <= remaining */
        break;
      }
      case 0xc8: { /* ext16 */
        uint16_t n;
        if (!ReadU16(&c, &n)) return kScanContinue;
        if (!Skip(&c, 1)) return kScanContinue;
        ScanStatus st = CheckBytes(n, static_cast<size_t>(c.end - c.p));
        if (st != kScanOk) return st;
        if (!Skip(&c, n)) return kScanContinue;  /* GCOVR_EXCL_BR_LINE: CheckBytes proved n <= remaining */
        break;
      }
      case 0xc9: { /* ext32 */
        uint32_t n;
        if (!ReadU32(&c, &n)) return kScanContinue;
        if (!Skip(&c, 1)) return kScanContinue;
        ScanStatus st = CheckBytes(n, static_cast<size_t>(c.end - c.p));
        if (st != kScanOk) return st;
        if (!Skip(&c, n)) return kScanContinue;  /* GCOVR_EXCL_BR_LINE: CheckBytes proved n <= remaining */
        break;
      }
      case 0xca: /* float32 */
        if (!Skip(&c, 4)) return kScanContinue;
        break;
      case 0xcb: /* float64 */
        if (!Skip(&c, 8)) return kScanContinue;
        break;
      case 0xcc: /* uint8 */
        if (!Skip(&c, 1)) return kScanContinue;
        break;
      case 0xcd: /* uint16 */
        if (!Skip(&c, 2)) return kScanContinue;
        break;
      case 0xce: /* uint32 */
        if (!Skip(&c, 4)) return kScanContinue;
        break;
      case 0xcf: /* uint64 */
        if (!Skip(&c, 8)) return kScanContinue;
        break;
      case 0xd0: /* int8 */
        if (!Skip(&c, 1)) return kScanContinue;
        break;
      case 0xd1: /* int16 */
        if (!Skip(&c, 2)) return kScanContinue;
        break;
      case 0xd2: /* int32 */
        if (!Skip(&c, 4)) return kScanContinue;
        break;
      case 0xd3: /* int64 */
        if (!Skip(&c, 8)) return kScanContinue;
        break;
      case 0xd4: /* fixext1 */
        if (!Skip(&c, 2)) return kScanContinue;
        break;
      case 0xd5: /* fixext2 */
        if (!Skip(&c, 3)) return kScanContinue;
        break;
      case 0xd6: /* fixext4 */
        if (!Skip(&c, 5)) return kScanContinue;
        break;
      case 0xd7: /* fixext8 */
        if (!Skip(&c, 9)) return kScanContinue;
        break;
      case 0xd8: /* fixext16 */
        if (!Skip(&c, 17)) return kScanContinue;
        break;
      case 0xd9: { /* str8 */
        uint8_t n;
        if (!ReadU8(&c, &n)) return kScanContinue;
        ScanStatus st = CheckBytes(n, static_cast<size_t>(c.end - c.p));
        if (st != kScanOk) return st;
        if (!Skip(&c, n)) return kScanContinue;  /* GCOVR_EXCL_BR_LINE: CheckBytes proved n <= remaining */
        break;
      }
      case 0xda: { /* str16 */
        uint16_t n;
        if (!ReadU16(&c, &n)) return kScanContinue;
        ScanStatus st = CheckBytes(n, static_cast<size_t>(c.end - c.p));
        if (st != kScanOk) return st;
        if (!Skip(&c, n)) return kScanContinue;  /* GCOVR_EXCL_BR_LINE: CheckBytes proved n <= remaining */
        break;
      }
      case 0xdb: { /* str32 */
        uint32_t n;
        if (!ReadU32(&c, &n)) return kScanContinue;
        ScanStatus st = CheckBytes(n, static_cast<size_t>(c.end - c.p));
        if (st != kScanOk) return st;
        if (!Skip(&c, n)) return kScanContinue;  /* GCOVR_EXCL_BR_LINE: CheckBytes proved n <= remaining */
        break;
      }
      case 0xdc: { /* array16 */
        uint16_t n;
        if (!ReadU16(&c, &n)) return kScanContinue;
        ScanStatus st = CheckContainer(n, static_cast<size_t>(c.end - c.p), false, sp);
        if (st != kScanOk) return st;
        stack[sp++].remaining = n;
        break;
      }
      case 0xdd: { /* array32 */
        uint32_t n;
        if (!ReadU32(&c, &n)) return kScanContinue;
        ScanStatus st = CheckContainer(n, static_cast<size_t>(c.end - c.p), false, sp);
        if (st != kScanOk) return st;
        stack[sp++].remaining = n;
        break;
      }
      case 0xde: { /* map16 */
        uint16_t n;
        if (!ReadU16(&c, &n)) return kScanContinue;
        ScanStatus st = CheckContainer(n, static_cast<size_t>(c.end - c.p), true, sp);
        if (st != kScanOk) return st;
        stack[sp++].remaining = static_cast<uint32_t>(n) * 2u;
        break;
      }
      case 0xdf: { /* map32 */
        uint32_t n;
        if (!ReadU32(&c, &n)) return kScanContinue;
        ScanStatus st = CheckContainer(n, static_cast<size_t>(c.end - c.p), true, sp);
        if (st != kScanOk) return st;
        stack[sp++].remaining = n * 2u;
        break;
      }
      default:
        return kScanParse;
    }
  }

  *consumed = static_cast<size_t>(c.p - reinterpret_cast<const unsigned char*>(data));
  return kScanOk;
}

class MsgpackException {
 public:
  explicit MsgpackException(v8::Local<v8::Value> err) : err_(err) {}
  v8::Local<v8::Value> value() const { return err_; }

 private:
  v8::Local<v8::Value> err_;
};

static v8::Local<v8::Value> Error(const char* msg) {
  return Nan::Error(msg);
}

/* Persistent identity flag for cycle detection (not enumerable).
 * thread_local because a v8::Persistent belongs to the isolate that created
 * it: with a process-global handle, a worker's Init() would dispose the main
 * isolate's string and then hand its own back to main-thread pack(). */
static thread_local Nan::Persistent<v8::String> stack_key;

static v8::Local<v8::String> StackKey() {
  return Nan::New(stack_key);
}

static void Mark(v8::Local<v8::Object> obj) {
  Nan::SetPrivate(obj, StackKey(), Nan::True());
}

static void Unmark(v8::Local<v8::Object> obj) {
  Nan::DeletePrivate(obj, StackKey());
}

static bool IsMarked(v8::Local<v8::Object> obj) {
  Nan::MaybeLocal<v8::Value> v = Nan::GetPrivate(obj, StackKey());
  /* A private-symbol read runs no interceptor and no Proxy trap, so it
   * cannot leave an exception pending and cannot come back empty. */
  if (v.IsEmpty()) return false;  /* GCOVR_EXCL_BR_LINE */
  return v.ToLocalChecked()->IsTrue();
}

static void JsToMsgpack(msgpack_packer* pk, v8::Local<v8::Value> o, int depth);

/*
 * Call a zero-argument JS method, converting a JS-level throw into a
 * MsgpackException carrying the original error so Pack() can rethrow it.
 */
static v8::Local<v8::Value> CallNoArgs(v8::Local<v8::Object> recv,
                                       v8::Local<v8::Function> fn) {
  Nan::TryCatch try_catch;
  Nan::MaybeLocal<v8::Value> r = Nan::Call(fn, recv, 0, NULL);
  if (r.IsEmpty()) {
    v8::Local<v8::Value> ex = try_catch.Exception();
    /* GCOVR_EXCL_BR_START: an empty Maybe always carries a pending
     * exception, so the empty-exception fallback is unreachable. */
    if (ex.IsEmpty()) {
      throw MsgpackException(Error("Error serializing object"));
    }
    /* GCOVR_EXCL_BR_STOP */
    throw MsgpackException(ex);
  }
  return r.ToLocalChecked();
}

/*
 * Property reads during packing can run arbitrary JS: an accessor, a Proxy
 * "get"/"ownKeys" trap, or an interceptor. When that JS throws, V8 hands back
 * an empty Maybe, and ToLocalChecked() on it aborts the process
 * ("FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal"). These wrappers turn
 * the throw into a MsgpackException carrying the original error, exactly as
 * CallNoArgs does for method calls.
 */
static void ThrowCaught(const Nan::TryCatch& try_catch) {
  v8::Local<v8::Value> ex = try_catch.Exception();
  /* GCOVR_EXCL_BR_START: see CallNoArgs -- unreachable fallback. */
  if (ex.IsEmpty()) {
    throw MsgpackException(Error("Error serializing object"));
  }
  /* GCOVR_EXCL_BR_STOP */
  throw MsgpackException(ex);
}

static v8::Local<v8::Value> CheckedGet(v8::Local<v8::Object> obj,
                                       v8::Local<v8::Value> key) {
  Nan::TryCatch try_catch;
  Nan::MaybeLocal<v8::Value> r = Nan::Get(obj, key);
  if (r.IsEmpty()) {
    ThrowCaught(try_catch);  /* GCOVR_EXCL_BR_LINE: never returns */
  }
  return r.ToLocalChecked();
}

static v8::Local<v8::Value> CheckedGet(v8::Local<v8::Object> obj, uint32_t index) {
  Nan::TryCatch try_catch;
  Nan::MaybeLocal<v8::Value> r = Nan::Get(obj, index);
  if (r.IsEmpty()) {
    ThrowCaught(try_catch);  /* GCOVR_EXCL_BR_LINE: never returns */
  }
  return r.ToLocalChecked();
}

static v8::Local<v8::Array> CheckedOwnNames(v8::Local<v8::Object> obj) {
  Nan::TryCatch try_catch;
  Nan::MaybeLocal<v8::Array> r = Nan::GetOwnPropertyNames(obj);
  if (r.IsEmpty()) {
    ThrowCaught(try_catch);  /* GCOVR_EXCL_BR_LINE: never returns */
  }
  return r.ToLocalChecked();
}

static void PackArray(msgpack_packer* pk, v8::Local<v8::Array> arr, int depth) {
  if (IsMarked(arr)) {
    throw MsgpackException(Error("Cowardly refusing to pack circular reference"));
  }
  Mark(arr);
  uint32_t len = arr->Length();
  /* GCOVR_EXCL_BR_START: msgpack_sbuffer_write only fails on realloc
   * failure, which no JS-reachable input can force. */
  if (msgpack_pack_array(pk, len)) {
    Unmark(arr);
    throw MsgpackException(Error("Error serializing object"));
  }
  /* GCOVR_EXCL_BR_STOP */
  try {
    for (uint32_t i = 0; i < len; i++) {
      JsToMsgpack(pk, CheckedGet(arr, i), depth);
    }
  } catch (...) {
    Unmark(arr);
    throw;
  }
  Unmark(arr);
}

static void PackObject(msgpack_packer* pk, v8::Local<v8::Object> obj, int depth) {
  if (IsMarked(obj)) {
    throw MsgpackException(Error("Cowardly refusing to pack circular reference"));
  }
  Mark(obj);

  /* toJSON wins over the map encoding, at every level, matching both
   * JSON.stringify and the top-level wrapper in lib/msgpack.js. */
  v8::Local<v8::Value> to_json;
  try {
    to_json = CheckedGet(obj, Nan::New("toJSON").ToLocalChecked());
  } catch (...) {
    Unmark(obj);
    throw;
  }
  if (to_json->IsFunction()) {
    try {
      JsToMsgpack(pk, CallNoArgs(obj, to_json.As<v8::Function>()), depth);
    } catch (...) {
      Unmark(obj);
      throw;
    }
    Unmark(obj);
    return;
  }

  /* Every own enumerable key is packed, numeric keys included; V8 hands back
   * index keys as Numbers, which JsToMsgpack packs as integer map keys. */
  v8::Local<v8::Array> names;
  try {
    names = CheckedOwnNames(obj);
  } catch (...) {
    Unmark(obj);
    throw;
  }
  uint32_t len = names->Length();
  /* GCOVR_EXCL_BR_START: allocation failure only, as in PackArray. */
  if (msgpack_pack_map(pk, len)) {
    Unmark(obj);
    throw MsgpackException(Error("Error serializing object"));
  }
  /* GCOVR_EXCL_BR_STOP */
  try {
    for (uint32_t i = 0; i < len; i++) {
      v8::Local<v8::Value> key = CheckedGet(names, i);
      JsToMsgpack(pk, key, depth);
      JsToMsgpack(pk, CheckedGet(obj, key), depth);
    }
  } catch (...) {
    Unmark(obj);
    throw;
  }
  Unmark(obj);
}

static void JsToMsgpack(msgpack_packer* pk, v8::Local<v8::Value> o, int depth) {
  int rc = 0;

  if (kMaxPackDepth < ++depth) {
    throw MsgpackException(
        Error("Cowardly refusing to pack object nested more than 512 levels deep"));
  }

  if (o->IsUndefined() || o->IsNull()) {
    rc = msgpack_pack_nil(pk);
  } else if (o->IsBoolean()) {
    rc = o->IsTrue() ? msgpack_pack_true(pk) : msgpack_pack_false(pk);
  } else if (o->IsNumber()) {
    double d = Nan::To<double>(o).FromJust();
    /* Only take an integer path when the value actually fits the integer
     * type; otherwise the cast is undefined behavior (1e30 became 2^64-1). */
    if (std::isfinite(d) && std::trunc(d) == d && d >= 0 && d < kTwoPow64) {
      rc = msgpack_pack_uint64(pk, static_cast<uint64_t>(d));
    } else if (std::isfinite(d) && std::trunc(d) == d && d < 0 && d >= kInt64Min) {
      rc = msgpack_pack_int64(pk, static_cast<int64_t>(d));
    } else {
      rc = msgpack_pack_double(pk, d);
    }
  } else if (o->IsString()) {
    Nan::Utf8String bytes(o);
    rc = msgpack_pack_str(pk, bytes.length());
    if (rc == 0) {  /* GCOVR_EXCL_BR_LINE: rc != 0 needs an allocation failure */
      rc = msgpack_pack_str_body(pk, *bytes, bytes.length());
    }
  } else if (o->IsDate()) {
    /* Dates pack as their ISO-8601 string, as they did before 2.0.0. */
    v8::Local<v8::Object> date = o.As<v8::Object>();
    v8::Local<v8::Value> fn =
        CheckedGet(date, Nan::New("toISOString").ToLocalChecked());
    if (!fn->IsFunction()) {
      throw MsgpackException(Error("cannot pack Date"));
    }
    v8::Local<v8::Value> iso = CallNoArgs(date, fn.As<v8::Function>());
    Nan::Utf8String bytes(iso);
    rc = msgpack_pack_str(pk, bytes.length());
    if (rc == 0) {  /* GCOVR_EXCL_BR_LINE: rc != 0 needs an allocation failure */
      rc = msgpack_pack_str_body(pk, *bytes, bytes.length());
    }
  } else if (o->IsArray()) {
    PackArray(pk, o.As<v8::Array>(), depth);
    return;
  } else if (node::Buffer::HasInstance(o)) {
    char* data = node::Buffer::Data(o.As<v8::Object>());
    size_t len = node::Buffer::Length(o.As<v8::Object>());
    rc = msgpack_pack_bin(pk, len);
    if (rc == 0) {  /* GCOVR_EXCL_BR_LINE: rc != 0 needs an allocation failure */
      rc = msgpack_pack_bin_body(pk, data, len);
    }
  } else if (o->IsFunction()) {
    throw MsgpackException(Error("cannot pack function"));
  } else if (o->IsObject()) {
    PackObject(pk, o.As<v8::Object>(), depth);
    return;
  } else {
    throw MsgpackException(Error("cannot pack object"));
  }

  /* GCOVR_EXCL_BR_START: every rc above comes from an sbuffer write. */
  if (rc) {
    throw MsgpackException(Error("Error serializing object"));
  }
  /* GCOVR_EXCL_BR_STOP */
}

static v8::Local<v8::Value> MsgpackToJs(const msgpack_object* mo);

static v8::Local<v8::Value> MsgpackToJs(const msgpack_object* mo) {
  switch (mo->type) {
    case MSGPACK_OBJECT_NIL:
      return Nan::Null();
    case MSGPACK_OBJECT_BOOLEAN:
      return Nan::New(mo->via.boolean);
    case MSGPACK_OBJECT_POSITIVE_INTEGER:
      /* Values that fit in 2^53-1 stay as Number; larger become the
       * closest Number (legacy behavior). */
      return Nan::New<v8::Number>(static_cast<double>(mo->via.u64));
    case MSGPACK_OBJECT_NEGATIVE_INTEGER:
      return Nan::New<v8::Number>(static_cast<double>(mo->via.i64));
    case MSGPACK_OBJECT_FLOAT32:
    case MSGPACK_OBJECT_FLOAT64:
      return Nan::New<v8::Number>(mo->via.f64);
    case MSGPACK_OBJECT_STR:
      if (mo->via.str.size == 0) {
        return Nan::New<v8::String>("").ToLocalChecked();
      }
      return Nan::New<v8::String>(mo->via.str.ptr, mo->via.str.size).ToLocalChecked();
    case MSGPACK_OBJECT_BIN:
      if (mo->via.bin.size == 0) {
        return Nan::NewBuffer(0).ToLocalChecked();
      }
      return Nan::CopyBuffer(mo->via.bin.ptr, mo->via.bin.size).ToLocalChecked();
    case MSGPACK_OBJECT_EXT:
      /* Fail closed on extension types: callers expecting core JSON-like
       * values should not silently receive opaque ext payloads. */
      throw MsgpackException(Error("cannot unpack ext type"));
    case MSGPACK_OBJECT_ARRAY: {
      v8::Local<v8::Array> arr = Nan::New<v8::Array>(mo->via.array.size);
      for (uint32_t i = 0; i < mo->via.array.size; i++) {
        Nan::Set(arr, i, MsgpackToJs(&mo->via.array.ptr[i]));
      }
      return arr;
    }
    case MSGPACK_OBJECT_MAP: {
      v8::Local<v8::Object> obj = Nan::New<v8::Object>();
      for (uint32_t i = 0; i < mo->via.map.size; i++) {
        const msgpack_object_kv* kv = &mo->via.map.ptr[i];
        v8::Local<v8::Value> key = MsgpackToJs(&kv->key);
        v8::Local<v8::Value> val = MsgpackToJs(&kv->val);
        /* DefineOwnProperty, not Set: Set would run the __proto__ setter
         * inherited from Object.prototype, letting a wire map replace the
         * decoded object's prototype. Every key becomes a plain own,
         * enumerable, writable, configurable data property. */
        Nan::MaybeLocal<v8::String> name = Nan::To<v8::String>(key);
        /* GCOVR_EXCL_BR_START: keys are decoded nil/bool/number/string/
         * Buffer/Array/plain Object, none of which can throw in ToString. */
        if (name.IsEmpty()) {
          throw MsgpackException(Error("cannot unpack map key"));
        }
        /* GCOVR_EXCL_BR_STOP */
        Nan::DefineOwnProperty(obj, name.ToLocalChecked(), val);
      }
      return obj;
    }
    default:
      /* Every msgpack_object_type value is handled above; this only fires
       * if the vendored library grows a new one. */
      throw MsgpackException(Error("Encountered unknown object type"));  /* GCOVR_EXCL_BR_LINE */
  }
}

struct SbufPool {
  msgpack_sbuffer* list[kSbufferPoolMax];
  size_t length;

  SbufPool() : list(), length(0) {}

  /* Each thread owns its pool, so release the cached sbuffers when the
   * thread goes away instead of leaking them per worker. */
  ~SbufPool() {
    while (length > 0) {
      msgpack_sbuffer_free(list[--length]);
    }
  }

 private:
  SbufPool(const SbufPool&);
  SbufPool& operator=(const SbufPool&);
};

/* thread_local, not process-global: a worker thread packing concurrently with
 * the main thread would otherwise hand the same sbuffer to both. */
static thread_local SbufPool sbuf_pool;

class PackBuffer {
 public:
  PackBuffer() : sb_(NULL), from_pool_(false) {
    if (sbuf_pool.length > 0) {
      sb_ = sbuf_pool.list[--sbuf_pool.length];
      from_pool_ = true;
      msgpack_sbuffer_clear(sb_);
    } else {
      sb_ = msgpack_sbuffer_new();
      from_pool_ = false;
    }
    /* GCOVR_EXCL_BR_START: pooled buffers are never NULL and
     * msgpack_sbuffer_new only returns NULL out of memory. */
    if (sb_ == NULL) {
      throw MsgpackException(Error("Error initializing packing buffer"));
    }
    /* GCOVR_EXCL_BR_STOP */
  }

  /* Offer the sbuffer back to this thread's pool whether or not it came from
   * there: only handing back pooled buffers would leave the pool permanently
   * empty, so every pack would malloc and every dtor would free. */
  ~PackBuffer() {
    /* sb_ is non-NULL from the ctor on (a throwing ctor runs no dtor) and
     * is only cleared on the last line of this function. */
    if (sb_ == NULL) return;  /* GCOVR_EXCL_BR_LINE */
    if (sbuf_pool.length == kSbufferPoolMax) {
      msgpack_sbuffer_free(sb_);
    } else {
      sbuf_pool.list[sbuf_pool.length++] = sb_;
    }
    sb_ = NULL;
  }

  msgpack_sbuffer* get() { return sb_; }
  bool from_pool() const { return from_pool_; }

  char* release_data(size_t* size) {
    *size = sb_->size;
    char* data = msgpack_sbuffer_release(sb_);
    return data;
  }

 private:
  PackBuffer(const PackBuffer&);
  PackBuffer& operator=(const PackBuffer&);
  msgpack_sbuffer* sb_;
  bool from_pool_;
};

static void MsgpackFree(char* data, void* hint) {
  (void)hint;
  free(data);
}

/* thread_local for the same reason as sbuf_pool: unpack() on a worker must
 * not clobber the value the main thread's unpack.bytes_remaining reads. */
static thread_local int remaining_bytes_in_buffer = 0;

NAN_METHOD(BytesRemaining) {
  info.GetReturnValue().Set(Nan::New<v8::Number>(remaining_bytes_in_buffer));
}

NAN_METHOD(Pack) {
  try {
    PackBuffer buf;
    msgpack_packer pk;
    msgpack_packer_init(&pk, buf.get(), msgpack_sbuffer_write);

    if (info.Length() == 1) {
      JsToMsgpack(&pk, info[0], 0);
    } else {
      /* GCOVR_EXCL_BR_START: allocation failure only. */
      if (msgpack_pack_array(&pk, info.Length())) {
        throw MsgpackException(Error("Error serializing object"));
      }
      /* GCOVR_EXCL_BR_STOP */
      for (int i = 0; i < info.Length(); i++) {
        JsToMsgpack(&pk, info[i], 0);
      }
    }

    if (buf.from_pool()) {
      info.GetReturnValue().Set(
          Nan::CopyBuffer(buf.get()->data, buf.get()->size).ToLocalChecked());
      return;
    }
    size_t size = 0;
    char* data = buf.release_data(&size);
    info.GetReturnValue().Set(
        Nan::NewBuffer(data, size, MsgpackFree, NULL).ToLocalChecked());
  } catch (const MsgpackException& e) {  /* GCOVR_EXCL_BR_LINE: nothing here throws another type */
    Nan::ThrowError(e.value());
  }
}

NAN_METHOD(Unpack) {
  if (info.Length() < 1 || !info[0]->IsObject() || !node::Buffer::HasInstance(info[0])) {
    return Nan::ThrowTypeError("First argument must be a Buffer");
  }

  v8::Local<v8::Object> buf = Nan::To<v8::Object>(info[0]).ToLocalChecked();
  char* data = node::Buffer::Data(buf);
  size_t len = node::Buffer::Length(buf);

  remaining_bytes_in_buffer = static_cast<int>(len);

  size_t consumed = 0;
  ScanStatus scan = ScanOne(data, len, &consumed);
  if (scan == kScanContinue) {
    remaining_bytes_in_buffer = static_cast<int>(len);
    info.GetReturnValue().Set(Nan::Null());
    return;
  }
  if (scan == kScanLimit) {
    return Nan::ThrowError("msgpack unpack limit exceeded");
  }
  if (scan == kScanParse) {
    return Nan::ThrowError("Encountered error unpacking buffer");
  }

  msgpack_unpacked result;
  msgpack_unpacked_init(&result);
  size_t off = 0;
  msgpack_unpack_return ret = msgpack_unpack_next(&result, data, len, &off);
  remaining_bytes_in_buffer = static_cast<int>(len - off);

  /* ScanOne has already walked the same grammar with limits at or below the
   * vendored library's own (511 vs 512 nested containers, the same 1e6
   * element cap), so once it reports kScanOk msgpack_unpack_next can only
   * report success. The CONTINUE / PARSE_ERROR / NOMEM arms below are kept
   * so a future divergence fails closed rather than reading result.data
   * uninitialised. */
  /* Only the SUCCESS disjunct is reachable: the vendored
   * msgpack_unpack_next never returns EXTRA_BYTES. */
  if (ret == MSGPACK_UNPACK_SUCCESS || ret == MSGPACK_UNPACK_EXTRA_BYTES) {  /* GCOVR_EXCL_BR_LINE */
    try {
      v8::Local<v8::Value> v = MsgpackToJs(&result.data);
      msgpack_unpacked_destroy(&result);
      info.GetReturnValue().Set(v);
      return;
    } catch (const MsgpackException& e) {  /* GCOVR_EXCL_BR_LINE: MsgpackToJs throws nothing else */
      msgpack_unpacked_destroy(&result);
      return Nan::ThrowError(e.value());
    }
  }

  /* GCOVR_EXCL_BR_START: unreachable tail, see above. */
  msgpack_unpacked_destroy(&result);
  if (ret == MSGPACK_UNPACK_CONTINUE) {
    remaining_bytes_in_buffer = static_cast<int>(len);
    info.GetReturnValue().Set(Nan::Null());
    return;
  }
  Nan::ThrowError("Encountered error unpacking buffer");
  /* GCOVR_EXCL_BR_STOP */
}

NAN_MODULE_INIT(Init) {
  stack_key.Reset(Nan::New("_msgpack_stack").ToLocalChecked());
  Nan::Set(target, Nan::New("pack").ToLocalChecked(),
           Nan::GetFunction(Nan::New<v8::FunctionTemplate>(Pack)).ToLocalChecked());
  Nan::Set(target, Nan::New("unpack").ToLocalChecked(),
           Nan::GetFunction(Nan::New<v8::FunctionTemplate>(Unpack)).ToLocalChecked());
  Nan::Set(target, Nan::New("bytesRemaining").ToLocalChecked(),
           Nan::GetFunction(Nan::New<v8::FunctionTemplate>(BytesRemaining)).ToLocalChecked());
}

/* Context-aware: without this the addon refuses to load in a worker_threads
 * Worker ("Module did not self-register"). NAN_MODULE_WORKER_ENABLED is the
 * right wrapper here -- Init is a NAN_MODULE_INIT, i.e. a one-argument
 * function, while NODE_MODULE_CONTEXT_AWARE expects a four-argument
 * addon_context_register_func and casts between the mismatched function
 * pointer types. */
NAN_MODULE_WORKER_ENABLED(msgpackBinding, Init)

}  // namespace
