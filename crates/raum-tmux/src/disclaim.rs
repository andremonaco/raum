//! macOS TCC "responsible process" disclaiming for the tmux server spawn.
//!
//! Background: macOS Sequoia's TCC "App Data" protection prompts when a process
//! reads another app's data (`~/Library/Application Support/…`, other bundles'
//! containers, iCloud, …). TCC attributes that access to the *responsible
//! process* — and for anything raum spawns, the responsible process is
//! raum.app. Every shell in a pane, and every tool it runs (e.g. `pulumi`,
//! whose SDK/credential/plugin lookups walk several foreign app dirs), is a
//! descendant of the `-L raum` tmux *server* daemon, which is itself forked out
//! of raum. So all of their foreign-data reads get charged to raum.app and the
//! user gets "raum would like to access data from other apps" — repeatedly, one
//! prompt per distinct foreign container.
//!
//! The fix every terminal emulator uses (iTerm2, WezTerm, Ghostty): call the
//! private-but-ABI-stable `responsibility_spawnattrs_setdisclaim()` before
//! `posix_spawn`, so the spawned process becomes its *own* responsible process
//! and the chain from it downward is no longer attributed to the host app.
//!
//! We only disclaim the ONE spawn that births the server, because the server
//! parents every shell. Client commands (`capture-pane`, `attach-session`,
//! `load-buffer`, …) never parent a shell, so they don't need it.
//!
//! Non-macOS targets have no TCC framework (Linux file access is plain Unix
//! permissions), so this is a no-op there.

/// Birth the `-L <socket>` tmux server with its TCC responsibility disclaimed.
///
/// On macOS this runs `<binary> -L <socket> start-server` through `posix_spawn`
/// with `responsibility_spawnattrs_setdisclaim`, so the server daemon — and
/// therefore every shell and tool that runs under it — is its own TCC
/// "responsible process" instead of inheriting raum.app's.
///
/// `start-server` is a no-op when a server already exists, so this is safe to
/// call on every session creation; the guarantee it provides is only that
/// *whenever the server is born, it's born disclaimed*. A server left alive by
/// an older (non-disclaimed) build is not retroactively fixed — it self-heals
/// the next time the server is created from cold.
///
/// Non-macOS targets have no TCC; this is a no-op that returns `Ok(())`.
#[cfg(target_os = "macos")]
pub fn birth_server(binary: &std::path::Path, socket: &str) -> std::io::Result<()> {
    imp::birth_server(binary, socket)
}

#[cfg(not(target_os = "macos"))]
pub fn birth_server(_binary: &std::path::Path, _socket: &str) -> std::io::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod imp {
    use std::ffi::CString;
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    // SAFETY (whole block): these are libSystem spawn primitives. Every pointer
    // handed to them (argv entries, `devnull`, `attr`, `fa`, `envp`) is derived
    // from a local that outlives the `posix_spawn` call, which fully consumes
    // its inputs before returning. attr/fa are initialised before use and
    // destroyed after; setter failures we ignore degrade to "not disclaimed" /
    // "stdio inherited", never to unsoundness. argv/envp are NUL-terminated and
    // the target binary is our own trusted tmux.
    unsafe extern "C" {
        // Private libSystem symbol, stable since 10.14 and used by every major
        // terminal to break TCC responsibility inheritance for child processes.
        // A disclaimed spawn makes the child its own TCC responsible process
        // instead of inheriting the caller's.
        fn responsibility_spawnattrs_setdisclaim(
            attrs: *mut libc::posix_spawnattr_t,
            disclaim: libc::c_int,
        ) -> libc::c_int;

        // The process environment. macOS forbids referencing `environ` directly
        // in a normally-linked image; this accessor is the blessed route. We
        // pass it through verbatim so the disclaimed server captures a global
        // environment byte-identical to a normal spawn (tmux seeds new sessions
        // from the server's start-time environment).
        fn _NSGetEnviron() -> *mut *const *const libc::c_char;
    }

    pub fn birth_server(binary: &Path, socket: &str) -> io::Result<()> {
        let nul =
            |what: &str| io::Error::new(io::ErrorKind::InvalidInput, format!("{what} has NUL"));
        let path = CString::new(binary.as_os_str().as_bytes()).map_err(|_| nul("tmux path"))?;
        let arg_l = CString::new("-L").expect("literal has no NUL");
        let arg_socket = CString::new(socket.as_bytes()).map_err(|_| nul("socket"))?;
        let arg_cmd = CString::new("start-server").expect("literal has no NUL");
        let devnull = CString::new("/dev/null").expect("literal has no NUL");

        // NUL-terminated argv; entries borrow the CStrings above for the call.
        let mut argv: [*mut libc::c_char; 5] = [
            path.as_ptr().cast_mut(),
            arg_l.as_ptr().cast_mut(),
            arg_socket.as_ptr().cast_mut(),
            arg_cmd.as_ptr().cast_mut(),
            std::ptr::null_mut(),
        ];

        unsafe {
            let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
            if libc::posix_spawnattr_init(&raw mut attr) != 0 {
                return Err(io::Error::last_os_error());
            }
            // The whole point: disclaim TCC responsibility for the child so the
            // server (and its shells) are no longer attributed to raum.app.
            let _ = responsibility_spawnattrs_setdisclaim(&raw mut attr, 1);

            let mut fa: libc::posix_spawn_file_actions_t = std::mem::zeroed();
            if libc::posix_spawn_file_actions_init(&raw mut fa) != 0 {
                libc::posix_spawnattr_destroy(&raw mut attr);
                return Err(io::Error::last_os_error());
            }
            // Detach the fast-exiting start-server client from raum's stdio so a
            // stray byte can't land in raum's stdout/stderr. Best-effort.
            for fd in 0..=2 {
                let flags = if fd == 0 {
                    libc::O_RDONLY
                } else {
                    libc::O_WRONLY
                };
                libc::posix_spawn_file_actions_addopen(
                    &raw mut fa,
                    fd,
                    devnull.as_ptr(),
                    flags,
                    0 as libc::mode_t,
                );
            }

            let envp = (*_NSGetEnviron()).cast::<*mut libc::c_char>();

            // `posix_spawnp` (not `posix_spawn`) so a bare `tmux` resolves via
            // $PATH, matching `std::process::Command`'s behaviour elsewhere.
            let mut pid: libc::pid_t = 0;
            let rc = libc::posix_spawnp(
                &raw mut pid,
                path.as_ptr(),
                &raw const fa,
                &raw const attr,
                argv.as_mut_ptr(),
                envp,
            );

            libc::posix_spawn_file_actions_destroy(&raw mut fa);
            libc::posix_spawnattr_destroy(&raw mut attr);

            if rc != 0 {
                return Err(io::Error::from_raw_os_error(rc));
            }

            // Reap start-server so it never lingers as a zombie. It exits as
            // soon as the server is up (or immediately, if one already ran).
            let mut status: libc::c_int = 0;
            loop {
                if libc::waitpid(pid, &raw mut status, 0) != -1 {
                    break;
                }
                let e = io::Error::last_os_error();
                if e.raw_os_error() != Some(libc::EINTR) {
                    return Err(e);
                }
            }
        }
        Ok(())
    }
}
