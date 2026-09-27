import {defineConfig} from '@playwright/test';
import base from './playwright.ui.config';

const port=Number(process.env.NERYA_BROWSER_REVIEW_PORT||3106);
/** Own the preview lifecycle; never reuse or stop an operator's app server. */
export default defineConfig({
  ...base,
  testMatch: 'browser-native.spec.ts',
  outputDir: './test-results/browser-native-review',
  use: {...base.use, baseURL:`http://127.0.0.1:${port}`},
  webServer: {
    command:`npm run dev -- --hostname 127.0.0.1 -p ${port}`,
    url:`http://127.0.0.1:${port}/browsers`,
    reuseExistingServer:false,
    timeout:90_000,
    env:{NERYA_UI_DIST_DIR:`.next-browser-review-${port}`,NERYA_UI_TSCONFIG:`tsconfig.browser-review-${port}.json`,NERYA_E2E:'1'},
  },
});
