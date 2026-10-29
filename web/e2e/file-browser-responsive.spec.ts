import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const widths = [320, 375, 390] as const;
const labels = ['编辑文件', '查看渲染结果', '查看差异', '下载文件', '复制路径', '插入路径'];

test.describe('file preview action layout', () => {
  for (const width of widths) {
    test(`keeps every action visible and clickable at ${width}px`, async ({ page }) => {
      const stylesPath = process.env.FILE_BROWSER_STYLES_PATH ?? resolve(process.cwd(), 'src/styles.css');
      const styles = readFileSync(stylesPath, 'utf8');
      await page.setViewportSize({ width, height: 260 });
      await page.setContent(`
        <style>:root { --sat: 0px; } html, body { margin: 0; padding: 0; } ${styles}</style>
        <div class="fb-preview" style="width:100vw;height:260px">
          <div class="fb-preview-header">
            <button class="fb-preview-back">←</button>
            <span class="fb-preview-name">非常非常长的中文文件名称用于验证窄屏布局.md</span>
            <div class="fb-preview-actions">
              ${labels.map((label) => `<button class="fb-diff-toggle">${label}</button>`).join('')}
            </div>
            <button class="fb-close">✕</button>
          </div>
        </div>
      `);

      const result = await page.locator('.fb-preview-actions .fb-diff-toggle').evaluateAll((buttons) => {
        const rects = buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height, minHeight: style.minHeight };
        });
        const intersects = rects.some((a, i) => rects.some((b, j) => i !== j && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
        const inViewport = rects.every((rect) => rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight);
        const clickable = buttons.every((button) => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit === button || button.contains(hit);
        });
        return { rects, intersects, inViewport, clickable };
      });

      expect(result.rects).toHaveLength(labels.length);
      expect(result.intersects).toBe(false);
      expect(result.inViewport).toBe(true);
      expect(result.clickable).toBe(true);
      expect(result.rects.every((rect) => rect.height >= 32)).toBe(true);
    });
  }
});
