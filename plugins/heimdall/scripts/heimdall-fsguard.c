/*
 * heimdall-fsguard — LD_PRELOAD write interposer (Heimdall Layer 2, runtime).
 *
 * Purpose (GH-657): the static scripts-bypass guard cannot tell, from a script's
 * text, whether a write actually targets a protected directory (the path can be
 * built from a variable, path.join, or concatenation). Instead of guessing, the
 * PreToolUse hook runs the command with this library preloaded; every libc
 * write entry point checks the RESOLVED target and returns EACCES when it lands
 * under a protected directory. Because LD_PRELOAD is inherited by child
 * processes, a spawned `node evil.js` is covered too.
 *
 * Config (set by the hook, per command — so the block is scoped to THIS agent's
 * session; an unlocked entry is simply omitted from the list):
 *   HEIMDALL_PROTECTED  colon-separated absolute directories to write-protect
 *   HEIMDALL_ALLOWED    colon-separated absolute dirs exempted (allowedPaths)
 *
 * Safety: reads pass untouched; only write-intent calls are checked. On any
 * internal resolution error the call is ALLOWED (fail-open) — this is a
 * defense-in-depth layer, and bricking every write on a resolver edge case is
 * worse than a rare miss. A reentrancy guard prevents recursion.
 *
 * Linux/glibc x86_64 (v1). Build: scripts/build-fsguard.sh.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_DIRS 64

static char *g_protected[MAX_DIRS];
static int g_nprotected = 0;
static char *g_allowed[MAX_DIRS];
static int g_nallowed = 0;
static int g_ready = 0;

static __thread int g_in_guard = 0;

static void load_list(const char *env, char **arr, int *count) {
  const char *val = getenv(env);
  *count = 0;
  if (!val || !*val) return;
  char *copy = strdup(val);
  if (!copy) return;
  char *save = NULL;
  char *tok = strtok_r(copy, ":", &save);
  while (tok && *count < MAX_DIRS) {
    if (tok[0] == '/') {
      /* store without a trailing slash for uniform prefix compares */
      size_t len = strlen(tok);
      while (len > 1 && tok[len - 1] == '/') tok[--len] = '\0';
      arr[*count] = strdup(tok);
      if (arr[*count]) (*count)++;
    }
    tok = strtok_r(NULL, ":", &save);
  }
  free(copy);
}

__attribute__((constructor)) static void fsguard_init(void) {
  load_list("HEIMDALL_PROTECTED", g_protected, &g_nprotected);
  load_list("HEIMDALL_ALLOWED", g_allowed, &g_nallowed);
  g_ready = 1;
}

/* dir == path, or path is strictly under dir (dir + "/..."). */
static int under(const char *path, const char *dir) {
  size_t dl = strlen(dir);
  if (strncmp(path, dir, dl) != 0) return 0;
  return path[dl] == '\0' || path[dl] == '/';
}

/*
 * Canonicalize `path` (relative to `dirfd`) to an absolute path with symlinks in
 * the existing prefix resolved. For a not-yet-existent leaf, resolve the parent
 * and re-append the basename. Returns 1 on success (out filled), 0 on failure.
 */
static int resolve_target(int dirfd, const char *path, char *out, size_t outsz) {
  char abs[PATH_MAX];
  if (path && path[0] == '/') {
    if (strlen(path) >= sizeof(abs)) return 0;
    strcpy(abs, path);
  } else if (dirfd == AT_FDCWD || dirfd == -100) {
    char cwd[PATH_MAX];
    if (!getcwd(cwd, sizeof(cwd))) return 0;
    if (snprintf(abs, sizeof(abs), "%s/%s", cwd, path ? path : "") >= (int)sizeof(abs))
      return 0;
  } else {
    char link[64];
    char base[PATH_MAX];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", dirfd);
    ssize_t n = readlink(link, base, sizeof(base) - 1);
    if (n < 0) return 0;
    base[n] = '\0';
    if (snprintf(abs, sizeof(abs), "%s/%s", base, path ? path : "") >= (int)sizeof(abs))
      return 0;
  }

  char resolved[PATH_MAX];
  if (realpath(abs, resolved)) {
    if (strlen(resolved) >= outsz) return 0;
    strcpy(out, resolved);
    return 1;
  }
  /* Leaf may not exist yet: resolve the parent dir, re-append the basename. */
  char tmp[PATH_MAX];
  strncpy(tmp, abs, sizeof(tmp) - 1);
  tmp[sizeof(tmp) - 1] = '\0';
  char *slash = strrchr(tmp, '/');
  if (!slash) return 0;
  const char *leaf = slash + 1;
  char parent[PATH_MAX];
  if (slash == tmp) {
    strcpy(parent, "/");
  } else {
    *slash = '\0';
    strcpy(parent, tmp);
  }
  char rparent[PATH_MAX];
  if (!realpath(parent, rparent)) return 0;
  if (snprintf(out, outsz, "%s/%s", (strcmp(rparent, "/") == 0 ? "" : rparent), leaf) >=
      (int)outsz)
    return 0;
  return 1;
}

/* Would a write to (dirfd, path) land in a protected, non-exempt location? */
static int denied(int dirfd, const char *path) {
  if (!g_ready || g_nprotected == 0 || !path) return 0;
  char resolved[PATH_MAX];
  if (!resolve_target(dirfd, path, resolved, sizeof(resolved))) return 0; /* fail-open */
  int hit = 0;
  for (int i = 0; i < g_nprotected; i++) {
    if (under(resolved, g_protected[i])) {
      hit = 1;
      break;
    }
  }
  if (!hit) return 0;
  for (int i = 0; i < g_nallowed; i++) {
    if (under(resolved, g_allowed[i])) return 0; /* explicitly allowed subtree */
  }
  return 1;
}

static int write_flags(int flags) {
  return (flags & O_ACCMODE) != O_RDONLY || (flags & (O_CREAT | O_TRUNC | O_APPEND));
}

static int write_mode(const char *mode) {
  return mode && (strchr(mode, 'w') || strchr(mode, 'a') || strchr(mode, '+'));
}

#define REAL(name) real_##name
#define BIND(ret, name, ...)                                                                       \
  static ret (*REAL(name))(__VA_ARGS__) = NULL;                                                     \
  static void bind_##name(void) {                                                                  \
    if (!REAL(name)) REAL(name) = dlsym(RTLD_NEXT, #name);                                          \
  }

BIND(int, open, const char *, int, ...)
BIND(int, open64, const char *, int, ...)
BIND(int, openat, int, const char *, int, ...)
BIND(int, openat64, int, const char *, int, ...)
BIND(int, creat, const char *, mode_t)
BIND(int, creat64, const char *, mode_t)
BIND(FILE *, fopen, const char *, const char *)
BIND(FILE *, fopen64, const char *, const char *)
BIND(FILE *, freopen, const char *, const char *, FILE *)
BIND(FILE *, freopen64, const char *, const char *, FILE *)
BIND(int, rename, const char *, const char *)
BIND(int, renameat, int, const char *, int, const char *)
BIND(int, unlink, const char *)
BIND(int, unlinkat, int, const char *, int)
BIND(int, remove, const char *)
BIND(int, rmdir, const char *)
BIND(int, mkdir, const char *, mode_t)
BIND(int, mkdirat, int, const char *, mode_t)
BIND(int, truncate, const char *, off_t)
BIND(int, truncate64, const char *, off_t)
BIND(int, symlink, const char *, const char *)
BIND(int, link, const char *, const char *)

static mode_t va_mode(int flags, va_list ap) {
  return (flags & (O_CREAT | O_TMPFILE)) ? (mode_t)va_arg(ap, int) : 0;
}

#define DENY_FD(dirfd, p)                                                                          \
  do {                                                                                             \
    if (!g_in_guard) {                                                                             \
      g_in_guard = 1;                                                                              \
      int d = denied((dirfd), (p));                                                                \
      g_in_guard = 0;                                                                              \
      if (d) {                                                                                     \
        errno = EACCES;                                                                            \
        return -1;                                                                                 \
      }                                                                                            \
    }                                                                                              \
  } while (0)

int open(const char *path, int flags, ...) {
  bind_open();
  va_list ap;
  va_start(ap, flags);
  mode_t mode = va_mode(flags, ap);
  va_end(ap);
  if (write_flags(flags)) DENY_FD(AT_FDCWD, path);
  return REAL(open)(path, flags, mode);
}

int open64(const char *path, int flags, ...) {
  bind_open64();
  va_list ap;
  va_start(ap, flags);
  mode_t mode = va_mode(flags, ap);
  va_end(ap);
  if (write_flags(flags)) DENY_FD(AT_FDCWD, path);
  return REAL(open64)(path, flags, mode);
}

int openat(int dirfd, const char *path, int flags, ...) {
  bind_openat();
  va_list ap;
  va_start(ap, flags);
  mode_t mode = va_mode(flags, ap);
  va_end(ap);
  if (write_flags(flags)) DENY_FD(dirfd, path);
  return REAL(openat)(dirfd, path, flags, mode);
}

int openat64(int dirfd, const char *path, int flags, ...) {
  bind_openat64();
  va_list ap;
  va_start(ap, flags);
  mode_t mode = va_mode(flags, ap);
  va_end(ap);
  if (write_flags(flags)) DENY_FD(dirfd, path);
  return REAL(openat64)(dirfd, path, flags, mode);
}

int creat(const char *path, mode_t mode) {
  bind_creat();
  DENY_FD(AT_FDCWD, path);
  return REAL(creat)(path, mode);
}

int creat64(const char *path, mode_t mode) {
  bind_creat64();
  DENY_FD(AT_FDCWD, path);
  return REAL(creat64)(path, mode);
}

static FILE *guard_fopen(FILE *(*fn)(const char *, const char *), const char *path,
                         const char *mode) {
  if (write_mode(mode) && !g_in_guard) {
    g_in_guard = 1;
    int d = denied(AT_FDCWD, path);
    g_in_guard = 0;
    if (d) {
      errno = EACCES;
      return NULL;
    }
  }
  return fn(path, mode);
}

FILE *fopen(const char *path, const char *mode) {
  bind_fopen();
  return guard_fopen(REAL(fopen), path, mode);
}
FILE *fopen64(const char *path, const char *mode) {
  bind_fopen64();
  return guard_fopen(REAL(fopen64), path, mode);
}
FILE *freopen(const char *path, const char *mode, FILE *stream) {
  bind_freopen();
  if (write_mode(mode) && !g_in_guard) {
    g_in_guard = 1;
    int d = denied(AT_FDCWD, path);
    g_in_guard = 0;
    if (d) {
      errno = EACCES;
      return NULL;
    }
  }
  return REAL(freopen)(path, mode, stream);
}
FILE *freopen64(const char *path, const char *mode, FILE *stream) {
  bind_freopen64();
  if (write_mode(mode) && !g_in_guard) {
    g_in_guard = 1;
    int d = denied(AT_FDCWD, path);
    g_in_guard = 0;
    if (d) {
      errno = EACCES;
      return NULL;
    }
  }
  return REAL(freopen64)(path, mode, stream);
}

int rename(const char *oldp, const char *newp) {
  bind_rename();
  DENY_FD(AT_FDCWD, newp); /* creating/overwriting under protected */
  DENY_FD(AT_FDCWD, oldp); /* rename REMOVES the source */
  return REAL(rename)(oldp, newp);
}

int renameat(int oldfd, const char *oldp, int newfd, const char *newp) {
  bind_renameat();
  DENY_FD(newfd, newp);
  DENY_FD(oldfd, oldp);
  return REAL(renameat)(oldfd, oldp, newfd, newp);
}

int unlink(const char *path) {
  bind_unlink();
  DENY_FD(AT_FDCWD, path);
  return REAL(unlink)(path);
}

int unlinkat(int dirfd, const char *path, int flags) {
  bind_unlinkat();
  DENY_FD(dirfd, path);
  return REAL(unlinkat)(dirfd, path, flags);
}

int remove(const char *path) {
  bind_remove();
  DENY_FD(AT_FDCWD, path);
  return REAL(remove)(path);
}

int rmdir(const char *path) {
  bind_rmdir();
  DENY_FD(AT_FDCWD, path);
  return REAL(rmdir)(path);
}

int mkdir(const char *path, mode_t mode) {
  bind_mkdir();
  DENY_FD(AT_FDCWD, path);
  return REAL(mkdir)(path, mode);
}

int mkdirat(int dirfd, const char *path, mode_t mode) {
  bind_mkdirat();
  DENY_FD(dirfd, path);
  return REAL(mkdirat)(dirfd, path, mode);
}

int truncate(const char *path, off_t length) {
  bind_truncate();
  DENY_FD(AT_FDCWD, path);
  return REAL(truncate)(path, length);
}

int truncate64(const char *path, off_t length) {
  bind_truncate64();
  DENY_FD(AT_FDCWD, path);
  return REAL(truncate64)(path, length);
}

int symlink(const char *target, const char *linkpath) {
  bind_symlink();
  DENY_FD(AT_FDCWD, linkpath); /* the link is created under protected */
  return REAL(symlink)(target, linkpath);
}

int link(const char *oldp, const char *newp) {
  bind_link();
  DENY_FD(AT_FDCWD, newp);
  return REAL(link)(oldp, newp);
}
