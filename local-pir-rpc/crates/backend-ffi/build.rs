// Locates the inspire-gpu checkout and produces the native libraries.
//
// Checkout resolution, in order:
//   1. $INSPIRE_GPU_DIR                 (explicit override, e.g. a dev tree)
//   2. <repo>/third_party/inspire-gpu   (the pinned git submodule — default)
//   3. ~/projects/inspire-gpu           (sibling-checkout convenience)
//
// Without the `gpu` feature: compiles the CPU sources directly with a C++
// compiler (client half only — no CMake, no CUDA, builds anywhere).
// With `gpu`: links prebuilt static libraries from $checkout/build if they
// exist, otherwise runs the CMake build itself (needs nvcc; auto-detected
// under /usr/local/cuda*). So on a CUDA box, `git clone --recursive` +
// `cargo test -p pir-server` is the whole setup.

use std::env;
use std::path::PathBuf;

fn inspire_dir() -> PathBuf {
    if let Ok(d) = env::var("INSPIRE_GPU_DIR") {
        return PathBuf::from(d);
    }
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let submodule = manifest.join("../../third_party/inspire-gpu");
    if submodule.join("src/capi.h").exists() {
        return submodule;
    }
    let home = env::var("HOME").expect("HOME not set");
    PathBuf::from(home).join("projects/inspire-gpu")
}

fn link_crypto() {
    if pkg_config::Config::new().probe("libcrypto").is_err() {
        println!("cargo:rustc-link-lib=crypto");
    }
}

fn find_nvcc() -> Option<PathBuf> {
    if let Ok(out) = std::process::Command::new("which").arg("nvcc").output() {
        if out.status.success() {
            return Some(PathBuf::from(
                String::from_utf8_lossy(&out.stdout).trim().to_string(),
            ));
        }
    }
    let mut candidates = vec![PathBuf::from("/usr/local/cuda/bin/nvcc")];
    if let Ok(entries) = std::fs::read_dir("/usr/local") {
        for e in entries.flatten() {
            let p = e.path().join("bin/nvcc");
            if e.file_name().to_string_lossy().starts_with("cuda-") && p.exists() {
                candidates.push(p);
            }
        }
    }
    candidates.into_iter().find(|p| p.exists())
}

fn main() {
    println!("cargo:rerun-if-env-changed=INSPIRE_GPU_DIR");
    let dir = inspire_dir();
    let src = dir.join("src");
    if !src.join("capi.h").exists() {
        panic!(
            "inspire-gpu checkout not found at {} — clone with --recursive \
             (git submodule update --init) or set INSPIRE_GPU_DIR",
            dir.display()
        );
    }

    if env::var("CARGO_FEATURE_GPU").is_ok() {
        // Prebuilt build/ directory wins (fast dev path); otherwise run the
        // CMake build ourselves into OUT_DIR.
        let prebuilt = dir.join("build");
        let libdir = if prebuilt.join("libinspire_gpu.a").exists() {
            prebuilt
        } else {
            let mut cfg = cmake::Config::new(&dir);
            cfg.build_target("inspire_gpu").profile("Release");
            if let Ok(arch) = env::var("INSPIRE_CUDA_ARCH") {
                cfg.define("CMAKE_CUDA_ARCHITECTURES", arch);
            }
            if let Some(nvcc) = find_nvcc() {
                cfg.define("CMAKE_CUDA_COMPILER", &nvcc);
            }
            cfg.build().join("build")
        };
        println!("cargo:rustc-link-search=native={}", libdir.display());
        println!("cargo:rustc-link-lib=static=inspire_gpu");
        println!("cargo:rustc-link-lib=static=inspire");
        for p in ["/usr/local/cuda/lib64", "/usr/local/cuda-12.9/lib64"] {
            if PathBuf::from(p).exists() {
                println!("cargo:rustc-link-search=native={}", p);
            }
        }
        println!("cargo:rustc-link-lib=dylib=cudart");
        println!("cargo:rustc-link-lib=dylib=stdc++");
        link_crypto();
    } else {
        let cpu_sources = [
            "params.cpp",
            "ntt.cpp",
            "ring.cpp",
            "crypto.cpp",
            "protocol.cpp",
            "capi_client.cpp",
        ];
        let mut cc = cc::Build::new();
        cc.cpp(true).std("c++17").opt_level(2).include(&src);
        // probe() also emits the -L/-l flags for libcrypto.
        match pkg_config::Config::new().probe("libcrypto") {
            Ok(lib) => {
                for p in lib.include_paths {
                    cc.include(p);
                }
            }
            Err(_) => println!("cargo:rustc-link-lib=crypto"),
        }
        for f in &cpu_sources {
            let p = src.join(f);
            println!("cargo:rerun-if-changed={}", p.display());
            cc.file(p);
        }
        println!("cargo:rerun-if-changed={}", src.join("capi.h").display());
        cc.compile("inspire_client");
    }
}
