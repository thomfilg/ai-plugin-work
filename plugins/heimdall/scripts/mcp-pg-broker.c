/*
 * mcp-pg-broker — setuid shim that runs a credential-reading wrapper as a
 * dedicated RUN_USER, so the calling (agent) uid cannot read the secrets file
 * or harvest the live server's password from /proc/<pid>/environ.
 *
 * GENERIC / PREBUILT-FRIENDLY: unlike the old build, nothing project-specific is
 * baked in at compile time. The binary reads NODE_BIN, WRAPPER, RUN_USER and
 * ALLOWED_CSV at runtime from a ROOT-OWNED config file (BROKER_CONF, default
 * /usr/local/lib/mcp-broker/broker.conf) written by setup-secrets-heimdall.sh.
 * That makes a single committed binary usable across every project — no
 * compiler needed at install time — while keeping the same boundary: the
 * config (paths + allow-list) lives in a root-owned file the agent cannot
 * modify, exactly as the compile-time -D values were immutable before.
 *
 * WHY SAFE TO LET THE AGENT RUN: it only ever exec()s the configured wrapper
 * with an allow-listed server name in a sanitized env; it never prints secrets.
 * Running it yields only the wrapped MCP server's stdio protocol.
 *
 * PREREQUISITES (enforced by the installer):
 *   1. secrets file -> owner RUN_USER, mode 0600
 *   2. this binary  -> owner RUN_USER, mode 6711 (setuid+setgid), not agent-writable
 *   3. BROKER_CONF  -> owner root, not group/world writable (verified at runtime below)
 *   4. WRAPPER (+ dir) -> not agent-writable
 *   5. agent uid must NOT have a root-equivalent path (docker socket / sudo)
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <pwd.h>
#include <sys/types.h>
#include <sys/stat.h>

#ifndef BROKER_CONF
#define BROKER_CONF "/usr/local/lib/mcp-broker/broker.conf"
#endif

static char NODE_BIN[4096];
static char WRAPPER[4096];
static char RUN_USER[256];
static char ALLOWED_CSV[8192];

static void assign(const char *k, const char *v) {
    if (!strcmp(k, "NODE_BIN")) snprintf(NODE_BIN, sizeof NODE_BIN, "%s", v);
    else if (!strcmp(k, "WRAPPER")) snprintf(WRAPPER, sizeof WRAPPER, "%s", v);
    else if (!strcmp(k, "RUN_USER")) snprintf(RUN_USER, sizeof RUN_USER, "%s", v);
    else if (!strcmp(k, "ALLOWED_CSV")) snprintf(ALLOWED_CSV, sizeof ALLOWED_CSV, "%s", v);
}

/* Read KEY=VALUE lines from the root-owned config. Refuse if the file is not
 * owned by root or is group/world writable (a tampered config could redirect
 * WRAPPER or widen the allow-list). Returns 1 on success, 0 on failure. */
static int load_config(void) {
    FILE *f = fopen(BROKER_CONF, "r");
    if (!f) { fprintf(stderr, "mcp-pg-broker: cannot open config %s\n", BROKER_CONF); return 0; }

    /* BROKER_TEST_SKIP_OWNER_CHECK is defined ONLY by the unit-test build so the
     * parse/allow logic can run against a non-root tmp config. It is NEVER set
     * for the shipped/committed binary (build-broker.sh does not define it). */
#ifndef BROKER_TEST_SKIP_OWNER_CHECK
    struct stat st;
    if (fstat(fileno(f), &st) != 0) { perror("fstat"); fclose(f); return 0; }
    if (st.st_uid != 0 || (st.st_mode & (S_IWGRP | S_IWOTH))) {
        fprintf(stderr, "mcp-pg-broker: config %s must be root-owned and not group/world writable\n", BROKER_CONF);
        fclose(f);
        return 0;
    }
#endif

    char line[12288];
    while (fgets(line, sizeof line, f)) {
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
        if (line[0] == '#' || line[0] == 0) continue;
        char *eq = strchr(line, '=');
        if (!eq) continue;
        *eq = 0;
        assign(line, eq + 1);
    }
    fclose(f);
    return 1;
}

static int allowed(const char *name) {
    if (!ALLOWED_CSV[0]) return 0;
    char buf[sizeof ALLOWED_CSV];
    strncpy(buf, ALLOWED_CSV, sizeof buf - 1);
    buf[sizeof buf - 1] = 0;
    for (char *t = strtok(buf, ","); t; t = strtok(NULL, ","))
        if (strcmp(name, t) == 0) return 1;
    return 0;
}

int main(int argc, char **argv) {
    if (!load_config()) return 1;
    if (!WRAPPER[0] || !RUN_USER[0] || !NODE_BIN[0]) {
        fprintf(stderr, "mcp-pg-broker: config missing NODE_BIN/WRAPPER/RUN_USER\n");
        return 1;
    }
    if (argc != 2) {
        fprintf(stderr, "usage: %s <server-name>\n", argv[0]);
        return 2;
    }
    if (!allowed(argv[1])) {
        fprintf(stderr, "mcp-pg-broker: server '%s' not allowed\n", argv[1]);
        return 2;
    }

    struct passwd *pw = getpwnam(RUN_USER);
    if (!pw) {
        fprintf(stderr, "mcp-pg-broker: user '%s' not found\n", RUN_USER);
        return 1;
    }

    /* Drop fully to RUN_USER (real, effective, saved) for gid then uid. Requires
     * the binary to be setuid+setgid RUN_USER (mode 6711). */
    if (setresgid(pw->pw_gid, pw->pw_gid, pw->pw_gid) != 0) { perror("setresgid"); return 1; }
    if (setresuid(pw->pw_uid, pw->pw_uid, pw->pw_uid) != 0) { perror("setresuid"); return 1; }
    if (pw->pw_uid != 0 && setuid(0) == 0) {
        fprintf(stderr, "mcp-pg-broker: failed to drop privileges\n");
        return 1;
    }

    /* Minimal, attacker-free environment (discards NODE_OPTIONS, LD_*, etc.). */
    static char path[] = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    static char api[]  = "DOCKER_API_VERSION=1.44";
    char home[512];
    snprintf(home, sizeof home, "HOME=%s", pw->pw_dir);
    char *newenv[] = { path, home, api, NULL };

    char *newargv[] = { NODE_BIN, WRAPPER, argv[1], NULL };
    execve(NODE_BIN, newargv, newenv);
    perror("execve");
    return 1;
}
