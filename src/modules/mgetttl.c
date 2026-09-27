/* MGETTTL module -- fetch string values and their remaining TTLs.
 *
 * MGETTTL returns one two-element array for each requested key:
 *   [value, remaining_ttl_ms]
 *
 * A missing key has a NULL value and a TTL of -2. A key without an expiry
 * has a TTL of -1. Non-string keys have a NULL value, matching MGET's
 * behavior for non-string values, while their expiry is still reported.
 *
 * -----------------------------------------------------------------------------
 *
 * Copyright (c) 2016-Present, Redis Ltd.
 * All rights reserved.
 *
 * Licensed under your choice of (a) the Redis Source Available License 2.0
 * (RSALv2); or (b) the Server Side Public License v1 (SSPLv1); or (c) the
 * GNU Affero General Public License v3 (AGPLv3).
 */

#include "../redismodule.h"

int MGetTTL_RedisCommand(RedisModuleCtx *ctx, RedisModuleString **argv, int argc) {
    RedisModule_AutoMemory(ctx);

    if (argc < 2) return RedisModule_WrongArity(ctx);

    RedisModule_ReplyWithArray(ctx, argc - 1);
    for (int i = 1; i < argc; i++) {
        RedisModuleKey *key = RedisModule_OpenKey(ctx, argv[i], REDISMODULE_READ);
        int key_type = RedisModule_KeyType(key);

        RedisModule_ReplyWithArray(ctx, 2);
        if (key_type == REDISMODULE_KEYTYPE_EMPTY) {
            RedisModule_ReplyWithNull(ctx);
            RedisModule_ReplyWithLongLong(ctx, -2);
        } else {
            if (key_type == REDISMODULE_KEYTYPE_STRING) {
                size_t value_len;
                char *value = RedisModule_StringDMA(key, &value_len, REDISMODULE_READ);
                if (value != NULL) {
                    RedisModule_ReplyWithStringBuffer(ctx, value, value_len);
                } else {
                    RedisModule_ReplyWithNull(ctx);
                }
            } else {
                RedisModule_ReplyWithNull(ctx);
            }

            RedisModule_ReplyWithLongLong(ctx, RedisModule_GetExpire(key));
        }

        RedisModule_CloseKey(key);
    }

    return REDISMODULE_OK;
}

int RedisModule_OnLoad(RedisModuleCtx *ctx, RedisModuleString **argv, int argc) {
    REDISMODULE_NOT_USED(argv);
    REDISMODULE_NOT_USED(argc);

    if (RedisModule_Init(ctx, "mgetttl", 1, REDISMODULE_APIVER_1) == REDISMODULE_ERR)
        return REDISMODULE_ERR;

    if (RedisModule_CreateCommand(ctx, "mgetttl", MGetTTL_RedisCommand,
        "readonly", 1, -1, 1) == REDISMODULE_ERR)
        return REDISMODULE_ERR;

    return REDISMODULE_OK;
}
