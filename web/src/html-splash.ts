/**
 * Direct-entry pages bypass the main App splash lifecycle. Remove the static
 * HTML splash as soon as their first layout commits so their own loading and
 * error states can remain visible.
 */
export function dismissHtmlSplashForDirectEntry(): void {
  document.getElementById('splash')?.remove();
}
