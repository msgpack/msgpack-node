{
	"targets": [
		{
				'target_name': 'libmsgpack',
				'include_dirs': [
					'msgpack-c/include'
				],
				'type': 'static_library',
				'sources': [
					'msgpack-c/src/objectc.c',
					'msgpack-c/src/unpack.c',
					'msgpack-c/src/vrefbuffer.c',
					'msgpack-c/src/zone.c',
					'msgpack-c/src/version.c'
				],
				'cflags_cc': [
					'-Wall',
					'-O3'
				],
				'cflags': [
					'-Wall',
					'-O3'
				],
				'cflags!': [
          '-fno-exceptions',
          '-Wno-unused-function'
        ],
				'cflags_cc!': [
          '-fno-exceptions',
          '-Wno-unused-function'
        ],
				'conditions': [
          ['OS=="mac"', {
            'configurations': {                                                 
              'Debug': {       
                'xcode_settings': {
                  'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
                  'WARNING_CFLAGS': ['-Wall', '-Wno-unused-function'],
                }
              },
              'Release': {
                'xcode_settings': {
                  'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
                  'WARNING_CFLAGS': ['-Wall', '-Wno-unused-function'],
                },
              },
            },
          }],
					['OS=="win"', {
						'configurations': {
							'Debug': {
								'msvs_settings': {
									'VCCLCompilerTool': {
										'CompileAs': '2',
										'ExceptionHandling': '1',
									},
								},
							},
							'Release': {
								'msvs_settings': {
									'VCCLCompilerTool': {
										'CompileAs': '2',
										'ExceptionHandling': '1',
									},
								},
							},
						},
					}]
				]
			},
	]
}
