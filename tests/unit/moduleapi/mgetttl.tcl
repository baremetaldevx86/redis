set testmodule [file normalize tests/modules/mgetttl.so]

start_server {tags {modules external:skip}} {
    r module load $testmodule

    foreach proto {2 3} {
        if {[lsearch $::denytags "resp3"] >= 0} {
            if {$proto == 3} {continue}
        } elseif {$::force_resp3} {
            if {$proto == 2} {continue}
        }
        r hello $proto

        test "RESP$proto: MGETTTL rejects missing arguments" {
            assert_error {ERR wrong number of arguments*} {r mgetttl}
        }

        # Fresh values for every test: the old StringDMA-based implementation
        # converts integer and embedded-string values to raw on the first read.
        foreach {name value encoding} [list \
            integer 123 int \
            negative -123 int \
            embedded hello embstr \
            empty {} embstr \
            binary "a\x00b\xff\r\n" embstr \
            raw [string repeat "a\x00b\xff" 20000] raw] {
            foreach expiring {0 1} {
                test "RESP$proto: MGETTTL preserves $name encoding and memory (expiry=$expiring)" {
                    set key "mgetttl:$name"
                    r set $key $value
                    if {$expiring} {r pexpire $key 60000}
                    assert_encoding $encoding $key
                    set memory [r memory usage $key]
                    set deadline [r pexpiretime $key]

                    for {set i 0} {$i < 3} {incr i} {
                        set before [r pttl $key]
                        # Repeated keys must retain their order, value, and TTL
                        # from the same command-time snapshot.
                        set result [r mgetttl $key $key]
                        set after [r pttl $key]
                        assert_equal 2 [llength $result]
                        assert_equal 2 [llength [lindex $result 0]]
                        assert_equal $value [lindex $result 0 0]
                        assert_equal [lindex $result 0] [lindex $result 1]
                        set ttl [lindex $result 0 1]
                        if {$expiring} {
                            assert {$ttl > 0 && $ttl <= $before && $ttl >= $after}
                        } else {
                            assert_equal -1 $ttl
                        }
                        assert_encoding $encoding $key
                        assert_equal $memory [r memory usage $key]
                        assert_equal $deadline [r pexpiretime $key]
                    }
                }
            }
        }

        test "RESP$proto: MGETTTL returns ordered values, missing keys, and non-string keys" {
            r flushdb
            r set mgetttl:string hello
            r set mgetttl:integer 123
            r hset mgetttl:hash field value
            r rpush mgetttl:list item
            assert_equal {{hello -1} {{} -2} {{} -1} {123 -1} {{} -1} {hello -1}} \
                [r mgetttl mgetttl:string mgetttl:missing mgetttl:hash \
                    mgetttl:integer mgetttl:list mgetttl:string]
        }

        test "RESP$proto: MGETTTL reports the TTL of non-string keys" {
            r pexpire mgetttl:hash 60000
            set before [r pttl mgetttl:hash]
            set result [r mgetttl mgetttl:hash]
            set after [r pttl mgetttl:hash]
            assert_equal {} [lindex $result 0 0]
            set ttl [lindex $result 0 1]
            assert {$ttl > 0 && $ttl <= $before && $ttl >= $after}
        }

        test "RESP$proto: MGETTTL distinguishes empty strings and null values on the wire" {
            r set mgetttl:empty ""
            set null [expr {$proto == 2 ? "\$-1\r\n" : "_\r\n"}]
            set expected "*3\r\n*2\r\n\$0\r\n\r\n:-1\r\n*2\r\n${null}:-2\r\n*2\r\n${null}:-1\r\n"
            r deferred 1
            r mgetttl mgetttl:empty mgetttl:missing mgetttl:list
            set reply [r rawread [string length $expected]]
            r deferred 0
            assert_equal $expected $reply
        }

        test "RESP$proto: MGETTTL lazily expires keys" {
            r flushdb
            r debug set-active-expire 0
            r set mgetttl:expired value PX 1
            after 20
            assert_equal 1 [r dbsize]
            set result [r mgetttl mgetttl:expired]
            r debug set-active-expire 1
            assert_equal {{{} -2}} $result
            assert_equal 0 [r dbsize]
        } {} {needs:debug}

        test "RESP$proto: MGETTTL handles many keys without changing their encodings" {
            r flushdb
            set keys {}
            set expected {}
            for {set i 0} {$i < 256} {incr i} {
                set key "mgetttl:$i"
                r set $key $i
                lappend keys $key
                lappend expected [list $i -1]
            }
            assert_equal $expected [r mgetttl {*}$keys]
            foreach key $keys {assert_encoding int $key}
        }

        test "RESP$proto: MGETTTL replies survive subsequent writes and async flush" {
            r flushdb
            set value [string repeat x 80000]
            r set mgetttl:raw $value
            r multi
            r mgetttl mgetttl:raw
            r append mgetttl:raw y
            r mgetttl mgetttl:raw
            r flushdb async
            set result [r exec]
            assert_equal [list [list $value -1]] [lindex $result 0]
            assert_equal 80001 [lindex $result 1]
            assert_equal [list [list "${value}y" -1]] [lindex $result 2]
            assert_equal OK [lindex $result 3]
        }

        r hello 2
    }

    test {Unload the module - mgetttl} {
        assert_equal {OK} [r module unload mgetttl]
    }
}
