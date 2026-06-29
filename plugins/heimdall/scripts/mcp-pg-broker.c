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
 * with an allow-listed name (plus optional trailing args, which reach only the
 * unprivileged wrapper) in a sanitized env; it never prints secrets. Running it
 * yields only the wrapped MCP server's stdio protocol, or — for CLI command
 * injection — the allow-listed command run as RUN_USER with the secret in its
 * environment.
 *
 * PREREQUISITES (enforced by the installer):
 *   1. secrets file -> owner RUN_USER, mode 0600
 *   2. this binary  -> owner root, mode 4711 (setuid root), not agent-writable.
 *      setuid root is required so it can drop the caller's supplementary groups
 *      (initgroups) before dropping to RUN_USER; it immediately and irrevocably
 *      drops all privilege below and only ever exec()s the fixed wrapper.
 *   3. BROKER_CONF  -> owner root, not group/world writable (verified at runtime below)
 *   4. WRAPPER (+ dir) -> not agent-writable
 *   5. agent uid must NOT have a root-equivalent path (docker socket / sudo)
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <pwd.h>
#include <grp.h>
#include <sys/types.h>
#include <sys/stat.h>

/* Fallback only. The config is normally read from `broker.conf` co-located with
 * THIS binary (see resolve_conf_path), so multiple repos can each install their
 * own broker+conf under a distinct path without sharing a single global file. */
#ifndef BROKER_CONF
#define BROKER_CONF "/usr/local/lib/mcp-broker/broker.conf"
#endif

/* Resolve broker.conf next to this executable (/proc/self/exe), falling back to
 * the compiled default if the self-path cannot be read. */
static void resolve_conf_path(char *buf, size_t n) {
    char exe[2048];
    ssize_t len = readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (len > 0) {
        exe[len] = 0;
        char *slash = strrchr(exe, '/');
        if (slash) {
            *slash = 0;
            snprintf(buf, n, "%s/broker.conf", exe);
            return;
        }
    }
    snprintf(buf, n, "%s", BROKER_CONF);
}

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
    char confPath[4096];
    resolve_conf_path(confPath, sizeof confPath);
    FILE *f = fopen(confPath, "r");
    if (!f) { fprintf(stderr, "mcp-pg-broker: cannot open config %s\n", confPath); return 0; }

    /* BROKER_TEST_SKIP_OWNER_CHECK is defined ONLY by the unit-test build so the
     * parse/allow logic can run against a non-root tmp config. It is NEVER set
     * for the shipped/committed binary (build-broker.sh does not define it). */
#ifndef BROKER_TEST_SKIP_OWNER_CHECK
    struct stat st;
    if (fstat(fileno(f), &st) != 0) { perror("fstat"); fclose(f); return 0; }
    if (st.st_uid != 0 || (st.st_mode & (S_IWGRP | S_IWOTH))) {
        fprintf(stderr, "mcp-pg-broker: config %s must be root-owned and not group/world writable\n", confPath);
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
    /* Require at least a name; allow trailing args, forwarded to the wrapper for
     * CLI command injection (an MCP server simply passes none, so argc==2 keeps
     * the old behavior exactly). Cap argc so the forwarded-args array stays small
     * and bounded. The allow-list still gates argv[1] (the logical name); the
     * trailing args reach only the UNPRIVILEGED wrapper, never a root process. */
    if (argc < 2) {
        fprintf(stderr, "usage: %s <name> [args...]\n", argv[0]);
        return 2;
    }
    if (argc > 256) {
        fprintf(stderr, "mcp-pg-broker: too many arguments\n");
        return 2;
    }
    if (!allowed(argv[1])) {
        fprintf(stderr, "mcp-pg-broker: name '%s' not allowed\n", argv[1]);
        return 2;
    }

    /* Capture the CALLER's real uid BEFORE dropping privileges. The broker drops
     * to RUN_USER, so the launched command would otherwise have no way to learn
     * who invoked it; exposing it as HEIMDALL_CALLER_UID lets a CLI consumer
     * chown its outputs back to the invoking user. */
    const uid_t caller_uid = getuid();

    struct passwd *pw = getpwnam(RUN_USER);
    if (!pw) {
        fprintf(stderr, "mcp-pg-broker: user '%s' not found\n", RUN_USER);
        return 1;
    }

    /* Replace the CALLER's supplementary groups with RUN_USER's own groups
     * BEFORE dropping uid — otherwise the agent's supplementary groups stay
     * attached to the RUN_USER process (privilege leak). initgroups (not
     * setgroups(0,NULL)) keeps RUN_USER's legitimate groups, e.g. the `docker`
     * group the installer adds for the atlassian MCP. Requires the binary to be
     * setuid ROOT (mode 4711) — a non-root euid cannot change groups. */
    if (initgroups(pw->pw_name, pw->pw_gid) != 0) { perror("initgroups"); return 1; }
    /* Drop fully to RUN_USER (real, effective, saved) for gid then uid. */
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
    char calleruid[64];
    snprintf(calleruid, sizeof calleruid, "HEIMDALL_CALLER_UID=%u", (unsigned)caller_uid);
    char *newenv[] = { path, home, api, calleruid, NULL };

    /* Forward argv[1..] to the wrapper: NODE_BIN WRAPPER <name> [args...].
     * For an MCP server argc==2, so this is exactly {NODE_BIN, WRAPPER, name,
     * NULL} as before. argc is capped above, so this stack array stays bounded. */
    char *newargv[argc + 2];
    newargv[0] = NODE_BIN;
    newargv[1] = WRAPPER;
    for (int i = 1; i < argc; i++) newargv[i + 1] = argv[i];
    newargv[argc + 1] = NULL;
    execve(NODE_BIN, newargv, newenv);
    perror("execve");
    return 1;
}
