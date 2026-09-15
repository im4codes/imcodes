const WINDOWS_POWERSHELL_MODULE_ROOT = 'Modules';

function modulePreflight(moduleName: string, variableName: string): string {
  const manifestName = `${moduleName}.psd1`;
  return `$${variableName} = Join-Path $PSHOME '${WINDOWS_POWERSHELL_MODULE_ROOT}\\${moduleName}\\${manifestName}'\r\n`
    + `if (-not (Test-Path -LiteralPath $${variableName} -PathType Leaf)) { throw 'Windows PowerShell ${moduleName} module was not found' }\r\n`
    + `Import-Module -Name $${variableName} -ErrorAction Stop\r\n`;
}

// A PowerShell 7 parent can leak its PSModulePath into a Windows PowerShell 5.1
// child. Resolve in-box modules from the child interpreter's immutable PSHOME
// so production scripts never depend on inherited module-discovery state.
export const WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT = modulePreflight(
  'Microsoft.PowerShell.Security',
  'securityModulePath',
);

export const WINDOWS_POWERSHELL_UTILITY_MODULE_PREFLIGHT = modulePreflight(
  'Microsoft.PowerShell.Utility',
  'utilityModulePath',
);
