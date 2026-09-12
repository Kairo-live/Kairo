// Lists font FAMILY names actually installed on the user's machine, for
// Theme Studio's font picker (makeFontSelect, app.js) — that dropdown used
// to only offer a small curated list of bundled Google Fonts, so a font the
// operator already has installed (a church brand font, something from a
// design pack) was never selectable at all, even though the real output
// (a WebKit view, same as any browser) would happily render it by name if
// it were only in the list.
//
// macOS only for now, via Core Text (CTFontManagerCopyAvailableFontFamilyNames)
// — reuses core-foundation, already a dependency for Syphon, rather than
// pulling in a new crate (font-kit and friends drag in FreeType/fontconfig
// on top, real weight for one string list). Every other platform gets an
// empty list back and the frontend just falls back to its existing curated
// set, same as before this existed.
#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
    }

    pub fn list_system_fonts() -> Vec<String> {
        unsafe {
            let arr_ref = CTFontManagerCopyAvailableFontFamilyNames();
            if arr_ref.is_null() {
                return Vec::new();
            }
            // wrap_under_create_rule takes ownership of the +1 retain
            // CTFontManagerCopy... already handed back, so this frees it
            // correctly when `arr` drops — no separate CFRelease needed.
            let arr: CFArray<CFString> = TCFType::wrap_under_create_rule(arr_ref);
            // CTFontManagerCopyAvailableFontFamilyNames returns EVERY family
            // macOS knows about, including the private, dot-prefixed ones the
            // OS uses for its own UI chrome (".SF NS", ".AppleSystemUIFont",
            // ".Keyboard", ".LastResort", etc.) — these carry glyphs for
            // system icons/UI substitution, not real Latin text coverage, so
            // rendering an operator's own font name in one of them produces
            // exactly the garbled/overlapping tofu the picker was showing.
            // Font Book and every other font-facing macOS app hide this same
            // "." prefix by convention; do the same here at the source so
            // every consumer of this list (not just today's picker) is clean.
            let mut names: Vec<String> = arr.iter()
                .map(|s| s.to_string())
                .filter(|n| !n.starts_with('.'))
                .collect();
            names.sort();
            names.dedup();
            names
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn list_system_fonts() -> Vec<String> {
        Vec::new()
    }
}

#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    platform::list_system_fonts()
}
