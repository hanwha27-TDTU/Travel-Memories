package app.bugeon.journey;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // 등록은 super.onCreate 앞이어야 한다 — 브리지가 그 시점에 플러그인 목록을 굳힌다.
    registerPlugin(OriginalPhotosPlugin.class);
    registerPlugin(IconSwitcherPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
