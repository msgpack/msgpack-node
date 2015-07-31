//
// MessagePack for C++ static resolution routine
//
// Copyright (C) 2015 KONDO Takatoshi
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//
//        http://www.apache.org/licenses/LICENSE-2.0
//
//    Unless required by applicable law or agreed to in writing, software
//    distributed under the License is distributed on an "AS IS" BASIS,
//    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//    See the License for the specific language governing permissions and
//    limitations under the License.
//
#ifndef MSGPACK_TYPE_VECTOR_BOOL_HPP
#define MSGPACK_TYPE_VECTOR_BOOL_HPP

#include "msgpack/versioning.hpp"
#include "msgpack/object_fwd.hpp"
#include <vector>

namespace msgpack {

/// @cond
MSGPACK_API_VERSION_NAMESPACE(v1) {
/// @endcond

namespace adaptor {

template <>
struct convert<std::vector<bool> > {
    msgpack::object const& operator()(msgpack::object const& o, std::vector<bool>& v) const {
        if (o.type != msgpack::type::ARRAY) { throw msgpack::type_error(); }
        if (o.via.array.size > 0) {
            v.resize(o.via.array.size);
            msgpack::object* p = o.via.array.ptr;
            for (std::vector<bool>::iterator it = v.begin(), end = v.end();
                 it != end;
                 ++it) {
                *it = p->as<bool>();
                ++p;
            }
        }
        return o;
    }
};

template <>
struct pack<std::vector<bool> > {
    template <typename Stream>
    msgpack::packer<Stream>& operator()(msgpack::packer<Stream>& o, const std::vector<bool>& v) const {
        uint32_t size = checked_get_container_size(v.size());
        o.pack_array(size);
        for(std::vector<bool>::const_iterator it(v.begin()), it_end(v.end());
            it != it_end; ++it) {
            o.pack(static_cast<bool>(*it));
        }
        return o;
    }
};

template <>
struct object_with_zone<std::vector<bool> > {
    void operator()(msgpack::object::with_zone& o, const std::vector<bool>& v) const {
        o.type = msgpack::type::ARRAY;
        if(v.empty()) {
            o.via.array.ptr = nullptr;
            o.via.array.size = 0;
        } else {
            uint32_t size = checked_get_container_size(v.size());
            msgpack::object* p = static_cast<msgpack::object*>(o.zone.allocate_align(sizeof(msgpack::object)*size));
            msgpack::object* const pend = p + size;
            o.via.array.ptr = p;
            o.via.array.size = size;
            std::vector<bool>::const_iterator it(v.begin());
            do {
                *p = msgpack::object(static_cast<bool>(*it), o.zone);
                ++p;
                ++it;
            } while(p < pend);
        }
    }
};

} // namespace adaptor

/// @cond
}  // MSGPACK_API_VERSION_NAMESPACE(v1)
/// @endcond

}  // namespace msgpack

#endif // MSGPACK_TYPE_VECTOR_BOOL_HPP
