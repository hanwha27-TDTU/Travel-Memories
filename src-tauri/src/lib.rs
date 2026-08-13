// Windows 셸은 제품 코어가 아니다. 네이티브 기능은 실제 필요가 증명될 때만
// capability와 플러그인을 함께 추가한다(docs/WINDOWS_TAURI.md).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Bugeon Journey Windows shell failed to start");
}
