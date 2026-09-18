{
  "targets": [
    {
      "target_name": "libmsgpack",
      "type": "static_library",
      "include_dirs": [ "include" ],
      "direct_dependent_settings": {
        "include_dirs": [ "include" ],
        "defines": [ "MSGPACK_EMBED_STACK_SIZE=512" ]
      },
      "defines": [
        "MSGPACK_ENDIAN_LITTLE_BYTE=1",
        "MSGPACK_ENDIAN_BIG_BYTE=0",
        "MSGPACK_EMBED_STACK_SIZE=512"
      ],
      "sources": [
        "src/objectc.c",
        "src/unpack.c",
        "src/version.c",
        "src/vrefbuffer.c",
        "src/zone.c"
      ],
      "cflags": [ "-Wall", "-O3", "-std=c99" ],
      "xcode_settings": {
        "OTHER_CFLAGS": [ "-Wall", "-O3", "-std=c99" ]
      }
    }
  ]
}
