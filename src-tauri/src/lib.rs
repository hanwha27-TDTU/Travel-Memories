// Windows OAuth는 새 프로세스로 돌아올 수 있다. single-instance를 **먼저** 등록해야
// deep-link 플러그인이 기존 창으로 URL을 전달한다(Tauri 공식 계약).
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("Bugeon Journey Windows shell failed to start");
}
