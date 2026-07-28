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
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_server_port",
                "get_server_token",
                "get_server_config",
                "signal_main_ready",
                "install_update",
                "ndi_available",
                "ndi_start",
                "ndi_stop",
                "ndi_update",
                "syphon_available",
                "syphon_start",
                "syphon_stop",
                "syphon_update",
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
    #[cfg(target_os = "macos")]
    {
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
