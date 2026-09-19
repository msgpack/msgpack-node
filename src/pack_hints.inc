enum PackType {
  kTypeNone = 0,
  kTypeFixint,
  kTypeUint8,
  kTypeUint16,
  kTypeUint32,
  kTypeUint64,
  kTypeInt8,
  kTypeInt16,
  kTypeInt32,
  kTypeInt64,
  kTypeFloat32,
  kTypeFloat64,
  kTypeFixstr,
  kTypeStr8,
  kTypeStr16,
  kTypeStr32,
  kTypeBin8,
  kTypeBin16,
  kTypeBin32,
  kTypeNil,
  kTypeTrue,
  kTypeFalse
};

enum PackFamily {
  kFamilyNone = 0,
  kFamilyInt,
  kFamilyFloat,
  kFamilyStr,
  kFamilyBin
};

struct PackHint {
  PackType type;
  PackFamily family;
  bool has_interpret;
  v8::Local<v8::Function> interpret;
  v8::Local<v8::Object> recv;
  PackHint()
      : type(kTypeNone),
        family(kFamilyNone),
        has_interpret(false) {}
};

static void ThrowCannotPackAs(const char* what) {
  char buf[80];
  std::snprintf(buf, sizeof(buf), "cannot pack value as %s", what);
  throw MsgpackException(Error(buf));
}

static const char* PackTypeName(PackType t) {
  switch (t) {
    case kTypeFixint: return "fixint";
    case kTypeUint8: return "uint8";
    case kTypeUint16: return "uint16";
    case kTypeUint32: return "uint32";
    case kTypeUint64: return "uint64";
    case kTypeInt8: return "int8";
    case kTypeInt16: return "int16";
    case kTypeInt32: return "int32";
    case kTypeInt64: return "int64";
    case kTypeFloat32: return "float32";
    case kTypeFloat64: return "float64";
    case kTypeFixstr: return "fixstr";
    case kTypeStr8: return "str8";
    case kTypeStr16: return "str16";
    case kTypeStr32: return "str32";
    case kTypeBin8: return "bin8";
    case kTypeBin16: return "bin16";
    case kTypeBin32: return "bin32";
    case kTypeNil: return "nil";
    case kTypeTrue: return "true";
    case kTypeFalse: return "false";
    default: return "type";
  }
}

static int WriteRaw(msgpack_packer* pk, const void* buf, size_t n) {
  return pk->callback(pk->data, static_cast<const char*>(buf), n);
}

static bool IsPackOptionsObject(v8::Local<v8::Value> v) {
  if (v.IsEmpty() || !v->IsObject() || v->IsArray() || v->IsDate() ||
      v->IsFunction() || v->IsRegExp() || v->IsNativeError() ||
      v->IsPromise() || v->IsTypedArray() || v->IsArrayBuffer() ||
      v->IsSharedArrayBuffer() || v->IsDataView() ||
      node::Buffer::HasInstance(v)) {
    return false;
  }
  v8::Local<v8::Object> obj = v.As<v8::Object>();
  Nan::TryCatch try_catch;
  v8::MaybeLocal<v8::Array> maybe_names = obj->GetOwnPropertyNames(
      Nan::GetCurrentContext(), v8::PropertyFilter::ONLY_ENUMERABLE);
  if (maybe_names.IsEmpty() || try_catch.HasCaught()) {
    try_catch.Reset();
    return false;
  }
  v8::Local<v8::Array> names = maybe_names.ToLocalChecked();
  bool saw = false;
  for (uint32_t i = 0; i < names->Length(); i++) {
    v8::Local<v8::Value> key = CheckedGet(names, i);
    if (!key->IsString()) {
      return false;
    }
    Nan::Utf8String s(key);
    if (std::strcmp(*s, "type") != 0 && std::strcmp(*s, "family") != 0 &&
        std::strcmp(*s, "interpret") != 0) {
      return false;
    }
    saw = true;
  }
  return saw;
}

static PackType ParsePackType(v8::Local<v8::Value> v) {
  if (!v->IsString()) {
    throw MsgpackException(Error("pack type must be a string"));
  }
  Nan::Utf8String s(v);
  const char* p = *s;
  if (std::strcmp(p, "fixint") == 0) return kTypeFixint;
  if (std::strcmp(p, "uint8") == 0) return kTypeUint8;
  if (std::strcmp(p, "uint16") == 0) return kTypeUint16;
  if (std::strcmp(p, "uint32") == 0) return kTypeUint32;
  if (std::strcmp(p, "uint64") == 0) return kTypeUint64;
  if (std::strcmp(p, "int8") == 0) return kTypeInt8;
  if (std::strcmp(p, "int16") == 0) return kTypeInt16;
  if (std::strcmp(p, "int32") == 0) return kTypeInt32;
  if (std::strcmp(p, "int64") == 0) return kTypeInt64;
  if (std::strcmp(p, "float32") == 0) return kTypeFloat32;
  if (std::strcmp(p, "float64") == 0) return kTypeFloat64;
  if (std::strcmp(p, "fixstr") == 0) return kTypeFixstr;
  if (std::strcmp(p, "str8") == 0) return kTypeStr8;
  if (std::strcmp(p, "str16") == 0) return kTypeStr16;
  if (std::strcmp(p, "str32") == 0) return kTypeStr32;
  if (std::strcmp(p, "bin8") == 0) return kTypeBin8;
  if (std::strcmp(p, "bin16") == 0) return kTypeBin16;
  if (std::strcmp(p, "bin32") == 0) return kTypeBin32;
  if (std::strcmp(p, "nil") == 0) return kTypeNil;
  if (std::strcmp(p, "true") == 0) return kTypeTrue;
  if (std::strcmp(p, "false") == 0) return kTypeFalse;
  throw MsgpackException(Error("unknown pack type"));
}

static PackFamily ParsePackFamily(v8::Local<v8::Value> v) {
  if (!v->IsString()) {
    throw MsgpackException(Error("pack family must be a string"));
  }
  Nan::Utf8String s(v);
  const char* p = *s;
  if (std::strcmp(p, "int") == 0) return kFamilyInt;
  if (std::strcmp(p, "float") == 0) return kFamilyFloat;
  if (std::strcmp(p, "str") == 0) return kFamilyStr;
  if (std::strcmp(p, "bin") == 0) return kFamilyBin;
  throw MsgpackException(Error("unknown pack family"));
}

static void FillHintFromObject(v8::Local<v8::Object> obj, PackHint* hint,
                               bool allow_interpret) {
  v8::Local<v8::String> kType = Nan::New("type").ToLocalChecked();
  v8::Local<v8::String> kFamily = Nan::New("family").ToLocalChecked();
  v8::Local<v8::String> kInterpret = Nan::New("interpret").ToLocalChecked();
  if (Nan::HasOwnProperty(obj, kType).FromMaybe(false)) {
    v8::Local<v8::Value> t = CheckedGet(obj, kType);
    if (!t->IsUndefined() && !t->IsNull()) {
      hint->type = ParsePackType(t);
    }
  }
  if (Nan::HasOwnProperty(obj, kFamily).FromMaybe(false)) {
    v8::Local<v8::Value> f = CheckedGet(obj, kFamily);
    if (!f->IsUndefined() && !f->IsNull()) {
      hint->family = ParsePackFamily(f);
    }
  }
  if (allow_interpret &&
      Nan::HasOwnProperty(obj, kInterpret).FromMaybe(false)) {
    v8::Local<v8::Value> fn = CheckedGet(obj, kInterpret);
    if (!fn->IsFunction()) {
      throw MsgpackException(Error("pack interpret must be a function"));
    }
    hint->has_interpret = true;
    hint->interpret = fn.As<v8::Function>();
    hint->recv = obj;
  }
}

static PackHint ParsePackOptions(v8::Local<v8::Object> obj) {
  PackHint hint;
  FillHintFromObject(obj, &hint, true);
  return hint;
}

static bool TryInt64(v8::Local<v8::Value> o, int64_t* out) {
  if (o->IsBigInt()) {
    bool lossless = false;
    *out = o.As<v8::BigInt>()->Int64Value(&lossless);
    return lossless;
  }
  if (!o->IsNumber()) {
    return false;
  }
  double d = Nan::To<double>(o).FromJust();
  if (!(std::isfinite(d) && std::trunc(d) == d)) {
    return false;
  }
  if (d >= 0 && d < kTwoPow64) {
    uint64_t u = static_cast<uint64_t>(d);
    if (u > static_cast<uint64_t>(INT64_MAX)) {
      return false;
    }
    *out = static_cast<int64_t>(u);
    return true;
  }
  if (d < 0 && d >= kInt64Min) {
    *out = static_cast<int64_t>(d);
    return true;
  }
  return false;
}

static bool TryUint64(v8::Local<v8::Value> o, uint64_t* out) {
  if (o->IsBigInt()) {
    bool lossless = false;
    *out = o.As<v8::BigInt>()->Uint64Value(&lossless);
    return lossless;
  }
  if (!o->IsNumber()) {
    return false;
  }
  double d = Nan::To<double>(o).FromJust();
  if (!(std::isfinite(d) && std::trunc(d) == d && d >= 0 && d < kTwoPow64)) {
    return false;
  }
  *out = static_cast<uint64_t>(d);
  return true;
}

static bool TryFloat(v8::Local<v8::Value> o, double* out) {
  if (!o->IsNumber()) {
    return false;
  }
  *out = Nan::To<double>(o).FromJust();
  return true;
}

static void RequireUint(v8::Local<v8::Value> o, uint64_t max, const char* name,
                        uint64_t* out) {
  if (!TryUint64(o, out) || *out > max) {
    ThrowCannotPackAs(name);
  }
}

static void RequireInt(v8::Local<v8::Value> o, int64_t lo, int64_t hi,
                       const char* name, int64_t* out) {
  if (!TryInt64(o, out) || *out < lo || *out > hi) {
    ThrowCannotPackAs(name);
  }
}

static void PackStrBytes(msgpack_packer* pk, PackType t, const char* data,
                         size_t len) {
  int rc = 0;
  unsigned char hdr[5];
  size_t hn = 0;
  switch (t) {
    case kTypeNone:
      rc = msgpack_pack_str(pk, len);
      if (rc == 0) {  /* GCOVR_EXCL_BR_LINE: rc != 0 needs an allocation failure */
        rc = msgpack_pack_str_body(pk, data, len);
      }
      if (rc != 0) {  /* GCOVR_EXCL_BR_LINE */
        throw MsgpackException(Error("Error serializing object"));
      }
      return;
    case kTypeFixstr:
      if (len > 31) {
        ThrowCannotPackAs("fixstr");
      }
      hdr[0] = static_cast<unsigned char>(0xa0u | len);
      hn = 1;
      break;
    case kTypeStr8:
      if (len > 255) {
        ThrowCannotPackAs("str8");
      }
      hdr[0] = 0xd9;
      hdr[1] = static_cast<unsigned char>(len);
      hn = 2;
      break;
    case kTypeStr16:
      if (len > 65535) {
        ThrowCannotPackAs("str16");
      }
      hdr[0] = 0xda;
      hdr[1] = static_cast<unsigned char>(len >> 8);
      hdr[2] = static_cast<unsigned char>(len);
      hn = 3;
      break;
    case kTypeStr32:
      hdr[0] = 0xdb;
      hdr[1] = static_cast<unsigned char>(len >> 24);
      hdr[2] = static_cast<unsigned char>(len >> 16);
      hdr[3] = static_cast<unsigned char>(len >> 8);
      hdr[4] = static_cast<unsigned char>(len);
      hn = 5;
      break;
    default:
      ThrowCannotPackAs("str");
  }
  rc = WriteRaw(pk, hdr, hn);
  if (rc == 0) {  /* GCOVR_EXCL_BR_LINE */
    rc = msgpack_pack_str_body(pk, data, len);
  }
  if (rc != 0) {  /* GCOVR_EXCL_BR_LINE */
    throw MsgpackException(Error("Error serializing object"));
  }
}

static void PackBinBytes(msgpack_packer* pk, PackType t, const char* data,
                         size_t len) {
  int rc = 0;
  unsigned char hdr[5];
  size_t hn = 0;
  switch (t) {
    case kTypeNone:
      rc = msgpack_pack_bin(pk, len);
      if (rc == 0) {  /* GCOVR_EXCL_BR_LINE: rc != 0 needs an allocation failure */
        rc = msgpack_pack_bin_body(pk, data, len);
      }
      if (rc != 0) {  /* GCOVR_EXCL_BR_LINE */
        throw MsgpackException(Error("Error serializing object"));
      }
      return;
    case kTypeBin8:
      if (len > 255) {
        ThrowCannotPackAs("bin8");
      }
      hdr[0] = 0xc4;
      hdr[1] = static_cast<unsigned char>(len);
      hn = 2;
      break;
    case kTypeBin16:
      if (len > 65535) {
        ThrowCannotPackAs("bin16");
      }
      hdr[0] = 0xc5;
      hdr[1] = static_cast<unsigned char>(len >> 8);
      hdr[2] = static_cast<unsigned char>(len);
      hn = 3;
      break;
    case kTypeBin32:
      hdr[0] = 0xc6;
      hdr[1] = static_cast<unsigned char>(len >> 24);
      hdr[2] = static_cast<unsigned char>(len >> 16);
      hdr[3] = static_cast<unsigned char>(len >> 8);
      hdr[4] = static_cast<unsigned char>(len);
      hn = 5;
      break;
    default:
      ThrowCannotPackAs("bin");
  }
  rc = WriteRaw(pk, hdr, hn);
  if (rc == 0) {  /* GCOVR_EXCL_BR_LINE */
    rc = msgpack_pack_bin_body(pk, data, len);
  }
  if (rc != 0) {  /* GCOVR_EXCL_BR_LINE */
    throw MsgpackException(Error("Error serializing object"));
  }
}

static void GetStrBytes(v8::Local<v8::Value> o, PackType t,
                        msgpack_packer* pk) {
  const char* name = (t == kTypeNone) ? "str" : PackTypeName(t);
  if (o->IsString()) {
    Nan::Utf8String u(o);
    PackStrBytes(pk, t, *u, static_cast<size_t>(u.length()));
    return;
  }
  if (o->IsDate()) {
    v8::Local<v8::Object> date = o.As<v8::Object>();
    v8::Local<v8::Value> fn =
        CheckedGet(date, Nan::New("toISOString").ToLocalChecked());
    if (!fn->IsFunction()) {
      throw MsgpackException(Error("cannot pack Date"));
    }
    v8::Local<v8::Value> iso = CallNoArgs(date, fn.As<v8::Function>());
    Nan::Utf8String u(iso);
    PackStrBytes(pk, t, *u, static_cast<size_t>(u.length()));
    return;
  }
  if (node::Buffer::HasInstance(o)) {
    v8::Local<v8::Object> b = o.As<v8::Object>();
    PackStrBytes(pk, t, node::Buffer::Data(b), node::Buffer::Length(b));
    return;
  }
  ThrowCannotPackAs(name);
}

static void GetBinBytes(v8::Local<v8::Value> o, PackType t,
                        msgpack_packer* pk) {
  const char* name = (t == kTypeNone) ? "bin" : PackTypeName(t);
  if (node::Buffer::HasInstance(o)) {
    v8::Local<v8::Object> b = o.As<v8::Object>();
    PackBinBytes(pk, t, node::Buffer::Data(b), node::Buffer::Length(b));
    return;
  }
  if (o->IsString()) {
    Nan::Utf8String u(o);
    PackBinBytes(pk, t, *u, static_cast<size_t>(u.length()));
    return;
  }
  ThrowCannotPackAs(name);
}

static void PackAsType(msgpack_packer* pk, v8::Local<v8::Value> o,
                       PackType t) {
  int rc = 0;
  uint64_t u = 0;
  int64_t s = 0;
  double d = 0;
  switch (t) {
    case kTypeFixint:
      RequireInt(o, -32, 127, "fixint", &s);
      {
        unsigned char b = static_cast<unsigned char>(static_cast<int8_t>(s));
        rc = WriteRaw(pk, &b, 1);
      }
      break;
    case kTypeUint8:
      RequireUint(o, 255ull, "uint8", &u);
      rc = msgpack_pack_fix_uint8(pk, static_cast<uint8_t>(u));
      break;
    case kTypeUint16:
      RequireUint(o, 65535ull, "uint16", &u);
      rc = msgpack_pack_fix_uint16(pk, static_cast<uint16_t>(u));
      break;
    case kTypeUint32:
      RequireUint(o, 0xffffffffull, "uint32", &u);
      rc = msgpack_pack_fix_uint32(pk, static_cast<uint32_t>(u));
      break;
    case kTypeUint64:
      RequireUint(o, UINT64_MAX, "uint64", &u);
      rc = msgpack_pack_fix_uint64(pk, u);
      break;
    case kTypeInt8:
      RequireInt(o, -128, 127, "int8", &s);
      rc = msgpack_pack_fix_int8(pk, static_cast<int8_t>(s));
      break;
    case kTypeInt16:
      RequireInt(o, -32768, 32767, "int16", &s);
      rc = msgpack_pack_fix_int16(pk, static_cast<int16_t>(s));
      break;
    case kTypeInt32:
      RequireInt(o, static_cast<int64_t>(INT32_MIN),
                 static_cast<int64_t>(INT32_MAX), "int32", &s);
      rc = msgpack_pack_fix_int32(pk, static_cast<int32_t>(s));
      break;
    case kTypeInt64:
      RequireInt(o, INT64_MIN, INT64_MAX, "int64", &s);
      rc = msgpack_pack_fix_int64(pk, s);
      break;
    case kTypeFloat32:
      if (!TryFloat(o, &d)) {
        ThrowCannotPackAs("float32");
      }
      rc = msgpack_pack_float(pk, static_cast<float>(d));
      break;
    case kTypeFloat64:
      if (!TryFloat(o, &d)) {
        ThrowCannotPackAs("float64");
      }
      rc = msgpack_pack_double(pk, d);
      break;
    case kTypeFixstr:
    case kTypeStr8:
    case kTypeStr16:
    case kTypeStr32:
      GetStrBytes(o, t, pk);
      return;
    case kTypeBin8:
    case kTypeBin16:
    case kTypeBin32:
      GetBinBytes(o, t, pk);
      return;
    case kTypeNil:
      if (!(o->IsNull() || o->IsUndefined())) {
        ThrowCannotPackAs("nil");
      }
      rc = msgpack_pack_nil(pk);
      break;
    case kTypeTrue:
      if (!o->IsTrue()) {
        ThrowCannotPackAs("true");
      }
      rc = msgpack_pack_true(pk);
      break;
    case kTypeFalse:
      if (!o->IsFalse()) {
        ThrowCannotPackAs("false");
      }
      rc = msgpack_pack_false(pk);
      break;
    default:
      ThrowCannotPackAs("type");
  }
  if (rc != 0) {  /* GCOVR_EXCL_BR_LINE: sbuffer write failure */
    throw MsgpackException(Error("Error serializing object"));
  }
}

static void PackAsFamily(msgpack_packer* pk, v8::Local<v8::Value> o,
                         PackFamily family) {
  int rc = 0;
  switch (family) {
    case kFamilyInt: {
      int64_t s = 0;
      uint64_t u = 0;
      if (TryInt64(o, &s)) {
        rc = msgpack_pack_int64(pk, s);
      } else if (TryUint64(o, &u)) {
        rc = msgpack_pack_uint64(pk, u);
      } else {
        ThrowCannotPackAs("int");
      }
      break;
    }
    case kFamilyFloat: {
      double d = 0;
      if (!TryFloat(o, &d)) {
        ThrowCannotPackAs("float");
      }
      if (std::isfinite(d)) {
        float f = static_cast<float>(d);
        if (static_cast<double>(f) == d) {
          rc = msgpack_pack_float(pk, f);
          break;
        }
      }
      rc = msgpack_pack_double(pk, d);
      break;
    }
    case kFamilyStr:
      GetStrBytes(o, kTypeNone, pk);
      return;
    case kFamilyBin:
      GetBinBytes(o, kTypeNone, pk);
      return;
    default:
      ThrowCannotPackAs("family");
  }
  if (rc != 0) {  /* GCOVR_EXCL_BR_LINE: sbuffer write failure */
    throw MsgpackException(Error("Error serializing object"));
  }
}

static void JsToMsgpackHinted(msgpack_packer* pk, v8::Local<v8::Value> o,
                              int depth, const PackHint& hint);

static void PackArrayInterpreted(msgpack_packer* pk, v8::Local<v8::Array> arr,
                                 int depth, const PackHint& hint) {
  if (IsMarked(arr)) {
    throw MsgpackException(Error("Cowardly refusing to pack circular reference"));
  }
  Mark(arr);
  try {
    /* GCOVR_EXCL_BR_START: allocation failure only. */
    if (msgpack_pack_array(pk, arr->Length())) {
      throw MsgpackException(Error("Error serializing object"));
    }
    /* GCOVR_EXCL_BR_STOP */
    for (uint32_t i = 0; i < arr->Length(); i++) {
      v8::Local<v8::Value> item = CheckedGet(arr, i);
      v8::Local<v8::Object> recv =
          hint.recv.IsEmpty() ? Nan::New<v8::Object>() : hint.recv;
      v8::Local<v8::Value> ret = CallOneArg(recv, hint.interpret, item);
      if (!ret->IsObject() || ret->IsArray() || ret->IsDate() ||
          ret->IsFunction() || node::Buffer::HasInstance(ret)) {
        throw MsgpackException(Error("interpret must return { data }"));
      }
      v8::Local<v8::Object> obj = ret.As<v8::Object>();
      v8::Local<v8::String> kData = Nan::New("data").ToLocalChecked();
      if (!Nan::HasOwnProperty(obj, kData).FromMaybe(false)) {
        throw MsgpackException(Error("interpret must return { data }"));
      }
      v8::Local<v8::Value> data = CheckedGet(obj, kData);
      PackHint inner;
      FillHintFromObject(obj, &inner, false);
      JsToMsgpackHinted(pk, data, depth, inner);
    }
  } catch (...) {
    Unmark(arr);
    throw;
  }
  Unmark(arr);
}

static void JsToMsgpackHinted(msgpack_packer* pk, v8::Local<v8::Value> o,
                              int depth, const PackHint& hint) {
  if (o->IsArray() && hint.has_interpret) {
    if (kMaxPackDepth < depth + 1) {
      throw MsgpackException(
          Error("Cowardly refusing to pack object nested more than 512 levels deep"));
    }
    PackArrayInterpreted(pk, o.As<v8::Array>(), depth + 1, hint);
    return;
  }
  if (hint.type != kTypeNone) {
    PackAsType(pk, o, hint.type);
    return;
  }
  if (hint.family != kFamilyNone) {
    PackAsFamily(pk, o, hint.family);
    return;
  }
  JsToMsgpack(pk, o, depth);
}
