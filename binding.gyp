{
  "variables": {
    # Off by default: `npm install` / `node-gyp rebuild` must produce a normal,
    # uninstrumented addon. Only `npm run coverage:native` sets this to 1.
    "msgpack_coverage%": 0
  },
  "targets": [
    {
      "target_name": "msgpackBinding",
      "sources": [ "src/msgpack.cc" ],
      "include_dirs": [
        "<!(node -e \"require('nan')\")"
      ],
      "defines": [
        "MSGPACK_EMBED_STACK_SIZE=512"
      ],
      "dependencies": [
        "deps/msgpack/msgpack.gyp:libmsgpack"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [ "-fexceptions", "-Wall" ],
      "cflags": [ "-Wall" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.15",
        "OTHER_CFLAGS": [ "-fexceptions", "-Wall" ]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      },
      "conditions": [
        ["msgpack_coverage==1", {
          # -O0 so gcov line/branch attribution matches the source; the
          # optimizer otherwise folds and clones branches out of existence.
          "cflags": [ "--coverage", "-O0", "-g" ],
          "cflags_cc": [ "--coverage", "-O0", "-g" ],
          "cflags!": [ "-O3", "-O2", "-O1" ],
          "cflags_cc!": [ "-O3", "-O2", "-O1" ],
          "ldflags": [ "--coverage" ],
          "xcode_settings": {
            "OTHER_CFLAGS": [ "--coverage", "-O0", "-g" ],
            "OTHER_LDFLAGS": [ "--coverage" ],
            "GCC_OPTIMIZATION_LEVEL": "0"
          }
        }]
      ]
    }
  ]
}
