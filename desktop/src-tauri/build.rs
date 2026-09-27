fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new().file("src/macos.m").flag("-fobjc-arc").flag("-fblocks")
            .flag("-mmacosx-version-min=12.0").compile("nerya_native");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rerun-if-changed=src/macos.m");
    }
    tauri_build::build()
}
