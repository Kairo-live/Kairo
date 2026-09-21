fn main() {
    // Declaring our own commands here is what makes them ACL-checkable at
    // all: `tauri_build::build()` (the bare call this used to be) never told
    // Tauri which commands the app registers, so `AppManifest::commands` was
    // empty and no `allow-<command>` permissions were ever generated for them
    // — every invoke() of get_server_token (and everything else below) was
    // hard-denied by the ACL before it could run, regardless of what the
    // capability file granted. This was the actual root cause of the
    // "unauthorized" bug: the auth token could never load because the very
    // command that fetches it was never a grantable permission in the first
    // place. See capabilities/main.json, which references the resulting
    // `allow-<command>` permissions.
    //
    // This list must match src/lib.rs's own `invoke_handler(generate_handler![...])`
    // exactly — 5 real commands (list_monitors, ndi_update_media/timer,
    // syphon_update_media/timer) had been registered there and called from
    // the frontend for a while without ever being added here, so every call
    // to them was silently hard-denied by the ACL regardless of the matching
    // `allow-*` entry already sitting in capabilities/main.json. list_monitors
    // backs the entire display/output picker; the update_media/update_timer
    // pair is what makes NDI/Syphon outputs show media and the timer at all.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_server_port",
                "get_server_token",
                "get_server_config",
                "list_monitors",
                "list_system_fonts",
                "signal_main_ready",
                "install_update",
                "ndi_available",
                "ndi_start",
                "ndi_stop",
                "ndi_update",
                "ndi_update_media",
                "ndi_update_timer",
                "syphon_available",
                "syphon_start",
                "syphon_stop",
                "syphon_update",
                "syphon_update_media",
                "syphon_update_timer",
            ]),
        ),
    )
    .expect("tauri_build failed");

    // ── macOS-only: link & bundle Syphon.framework ───────────────────────
    // Syphon is the standard macOS shared-texture protocol used by ProPresenter,
    // OBS (via plugin), Resolume, MadMapper, etc. We bundle the framework into
    // the .app's Contents/Frameworks dir (Tauri does that via tauri.conf.json's
    // bundle.macOS.frameworks) and tell rustc to link against it at build time.
    //
    // The @executable_path-relative rpath ensures dyld finds the framework at
    // runtime — both inside the bundled .app (where the binary lives at
    // Contents/MacOS/kairo and the framework at Contents/Frameworks/Syphon.framework)
    // and during cargo-run dev builds (where we point at the in-tree Frameworks/).
    //
    // Deliberately checked via CARGO_CFG_TARGET_OS (the env var Cargo sets to
    // the actual TARGET being built), not #[cfg(target_os = "macos")] — a
    // build.rs's own #[cfg] attributes reflect the HOST it's compiled and run
    // on, not the target, since build scripts always execute on the host.
    // On a real Mac building for itself the two happen to coincide, which
    // hid this; it surfaces the moment anyone cross-compiles the Windows
    // build from a macOS/Linux CI runner (confirmed via `cargo xwin check
    // --target x86_64-pc-windows-msvc`, which failed with "library kind
    // `framework` is only supported on Apple targets" under the old check).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        println!("cargo:rustc-link-search=framework={}/Frameworks", manifest);
        println!("cargo:rustc-link-lib=framework=Syphon");
        // Production rpath: points at the framework copied into the .app bundle.
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        // Dev rpath: lets `cargo run` from src-tauri/ find the in-tree copy.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}/Frameworks", manifest);
        println!("cargo:rerun-if-changed=Frameworks/Syphon.framework/Syphon");
    }
}
