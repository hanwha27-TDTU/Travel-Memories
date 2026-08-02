package app.bugeon.journey;

// IconSwitcherPlugin — 런처 아이콘을 앱 안에서 바꾼다 (ADR-0038).
//
// ─────────────────────────────────────────────────────────────────────────────
// 어떻게 (activity-alias)
// ─────────────────────────────────────────────────────────────────────────────
// 아이콘 하나 = activity-alias 하나(AndroidManifest). **정확히 하나만 enabled**이고, 전환은
// setComponentEnabledSetting으로 대상 alias를 켜고 나머지를 끈다. LAUNCHER는 MainActivity가
// 아니라 alias들이 가지므로(매니페스트 참조), 전환이 MainActivity(딥링크·singleTask)를
// 건드리지 않는다.
//
// 🔴 정직한 한계(사용자에게 안내됨):
//  · 웹/PWA에는 없다 — 설치 시 아이콘이 고정되므로 이 플러그인은 셸에만 있다.
//  · DONT_KILL_APP으로 앱을 죽이지 않지만, 런처가 새 아이콘을 **즉시** 안 바꾸고 잠시 뒤
//    (또는 홈 재진입/재부팅 후) 반영할 수 있다 — 안드로이드 공통 동작이라 여기서 못 고친다.
//  · 이 네이티브 코드는 CI에서만 컴파일되고, 실제 전환 동작은 사용자 실기기에서 확인한다(셸 §4).

import android.content.ComponentName;
import android.content.pm.PackageManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.LinkedHashMap;
import java.util.Map;

@CapacitorPlugin(name = "IconSwitcher")
public class IconSwitcherPlugin extends Plugin {

    // 키 → alias 클래스명. **매니페스트의 activity-alias android:name과 글자 단위로 일치**해야 한다.
    // 순서 = 웹 갤러리 표시 순서. 첫째(passport)가 기본.
    private static final Map<String, String> ALIASES = new LinkedHashMap<>();
    static {
        ALIASES.put("passport", "IconPassport");
        ALIASES.put("compass", "IconCompass");
        ALIASES.put("globe", "IconGlobe");
        ALIASES.put("suitcase", "IconSuitcase");
        ALIASES.put("mountain", "IconMountain");
    }

    private ComponentName comp(String alias) {
        return new ComponentName(getContext(), getContext().getPackageName() + "." + alias);
    }

    /** 지원 키 목록 + 현재 선택. 이 메서드가 응답하면 곧 「셸에서 실행 중」이라는 신호다. */
    @PluginMethod
    public void available(PluginCall call) {
        JSArray keys = new JSArray();
        for (String k : ALIASES.keySet()) keys.put(k);
        JSObject ret = new JSObject();
        ret.put("keys", keys);
        ret.put("current", currentKey());
        call.resolve(ret);
    }

    @PluginMethod
    public void getIcon(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("current", currentKey());
        call.resolve(ret);
    }

    @PluginMethod
    public void setIcon(PluginCall call) {
        String key = call.getString("key");
        if (key == null || !ALIASES.containsKey(key)) {
            call.reject("unknown-icon");
            return;
        }
        PackageManager pm = getContext().getPackageManager();
        try {
            for (Map.Entry<String, String> e : ALIASES.entrySet()) {
                int state = e.getKey().equals(key)
                    ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                    : PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
                pm.setComponentEnabledSetting(comp(e.getValue()), state, PackageManager.DONT_KILL_APP);
            }
            JSObject ret = new JSObject();
            ret.put("current", key);
            call.resolve(ret);
        } catch (Exception ex) {
            // 사유를 그대로 돌려준다 — 실기기에서 실패하면 이 문자열이 원인을 말한다(§8 규율).
            call.reject("set-failed:" + ex.getMessage());
        }
    }

    /** 명시적으로 ENABLED인 alias를 찾는다. 전환 전(전부 DEFAULT)에는 매니페스트 기본 = passport. */
    private String currentKey() {
        PackageManager pm = getContext().getPackageManager();
        for (Map.Entry<String, String> e : ALIASES.entrySet()) {
            if (pm.getComponentEnabledSetting(comp(e.getValue())) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) {
                return e.getKey();
            }
        }
        return "passport";
    }
}
