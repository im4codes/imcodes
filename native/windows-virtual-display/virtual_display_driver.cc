// Derived from Microsoft's IddSample (MS-PL); see LICENSE.microsoft.txt.
// The IM.codes changes reduce the sample to one isolated on-demand headless
// display, use stable product identity, bound the mode list, and harden all
// swap-chain/resource teardown paths. Pixel data is never persisted here.

#include "virtual_display_driver.h"

#include <array>
#include <new>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace imcodes::virtual_display {
namespace {

struct DisplayMode {
  DWORD width;
  DWORD height;
  DWORD refresh_hz;
};

// 1080p is deliberately preferred. 4K is exposed for qualified clients, but
// WebRTC's independent feedback ladder remains responsible for encode FPS.
constexpr std::array<DisplayMode, 6> kModes{{
    {1920, 1080, 60},
    {2560, 1440, 60},
    {3840, 2160, 60},
    {1600, 900, 60},
    {1280, 720, 60},
    {1024, 768, 60},
}};

// Stable identity for the single virtual connector. This is not a physical
// monitor EDID and does not impersonate another manufacturer's hardware.
constexpr GUID kMonitorContainerId = {
    0x97c2c02e, 0x7cb4, 0x4a8c,
    {0x9e, 0xe4, 0xf4, 0x69, 0x19, 0x67, 0x0c, 0x25}};

void FillSignalInfo(DISPLAYCONFIG_VIDEO_SIGNAL_INFO& signal,
                    const DisplayMode& mode,
                    bool monitor_mode) {
  signal.totalSize.cx = signal.activeSize.cx = mode.width;
  signal.totalSize.cy = signal.activeSize.cy = mode.height;
  signal.AdditionalSignalInfo.vSyncFreqDivider = monitor_mode ? 0 : 1;
  signal.AdditionalSignalInfo.videoStandard = 255;
  signal.vSyncFreq.Numerator = mode.refresh_hz;
  signal.vSyncFreq.Denominator = 1;
  signal.hSyncFreq.Numerator = mode.refresh_hz * mode.height;
  signal.hSyncFreq.Denominator = 1;
  signal.scanLineOrdering = DISPLAYCONFIG_SCANLINE_ORDERING_PROGRESSIVE;
  signal.pixelRate = static_cast<UINT64>(mode.refresh_hz) * mode.width *
                     mode.height;
}

IDDCX_MONITOR_MODE MonitorMode(const DisplayMode& source) {
  IDDCX_MONITOR_MODE mode{};
  mode.Size = sizeof(mode);
  mode.Origin = IDDCX_MONITOR_MODE_ORIGIN_DRIVER;
  FillSignalInfo(mode.MonitorVideoSignalInfo, source, true);
  return mode;
}

IDDCX_TARGET_MODE TargetMode(const DisplayMode& source) {
  IDDCX_TARGET_MODE mode{};
  mode.Size = sizeof(mode);
  FillSignalInfo(mode.TargetVideoSignalInfo.targetVideoSignalInfo, source,
                 false);
  return mode;
}

}  // namespace

}  // namespace imcodes::virtual_display

using imcodes::virtual_display::DeviceContext;
using imcodes::virtual_display::MonitorContext;

struct DeviceContextWrapper {
  DeviceContext* context = nullptr;
  void Cleanup() {
    delete context;
    context = nullptr;
  }
};

struct MonitorContextWrapper {
  MonitorContext* context = nullptr;
  void Cleanup() {
    delete context;
    context = nullptr;
  }
};

WDF_DECLARE_CONTEXT_TYPE(DeviceContextWrapper);
WDF_DECLARE_CONTEXT_TYPE(MonitorContextWrapper);

extern "C" DRIVER_INITIALIZE DriverEntry;
EVT_WDF_DRIVER_DEVICE_ADD ImcodesDeviceAdd;
EVT_WDF_DEVICE_D0_ENTRY ImcodesDeviceD0Entry;
EVT_WDF_OBJECT_CONTEXT_CLEANUP ImcodesDeviceContextCleanup;
EVT_WDF_OBJECT_CONTEXT_CLEANUP ImcodesMonitorContextCleanup;
EVT_IDD_CX_ADAPTER_INIT_FINISHED ImcodesAdapterInitFinished;
EVT_IDD_CX_ADAPTER_COMMIT_MODES ImcodesAdapterCommitModes;
EVT_IDD_CX_PARSE_MONITOR_DESCRIPTION ImcodesParseMonitorDescription;
EVT_IDD_CX_MONITOR_GET_DEFAULT_DESCRIPTION_MODES ImcodesGetDefaultModes;
EVT_IDD_CX_MONITOR_QUERY_TARGET_MODES ImcodesQueryTargetModes;
EVT_IDD_CX_MONITOR_ASSIGN_SWAPCHAIN ImcodesAssignSwapChain;
EVT_IDD_CX_MONITOR_UNASSIGN_SWAPCHAIN ImcodesUnassignSwapChain;

extern "C" BOOL WINAPI DllMain(HINSTANCE, UINT, LPVOID) { return TRUE; }

_Use_decl_annotations_ void ImcodesDeviceContextCleanup(WDFOBJECT object) {
  WdfObjectGet_DeviceContextWrapper(object)->Cleanup();
}

_Use_decl_annotations_ void ImcodesMonitorContextCleanup(WDFOBJECT object) {
  WdfObjectGet_MonitorContextWrapper(object)->Cleanup();
}

_Use_decl_annotations_ extern "C" NTSTATUS DriverEntry(
    PDRIVER_OBJECT driver_object,
    PUNICODE_STRING registry_path) {
  WDF_DRIVER_CONFIG config;
  WDF_DRIVER_CONFIG_INIT(&config, ImcodesDeviceAdd);
  WDF_OBJECT_ATTRIBUTES attributes;
  WDF_OBJECT_ATTRIBUTES_INIT(&attributes);
  return WdfDriverCreate(driver_object, registry_path, &attributes, &config,
                         WDF_NO_HANDLE);
}

_Use_decl_annotations_ NTSTATUS ImcodesDeviceAdd(
    WDFDRIVER driver,
    PWDFDEVICE_INIT device_init) {
  UNREFERENCED_PARAMETER(driver);
  WDF_PNPPOWER_EVENT_CALLBACKS power_callbacks;
  WDF_PNPPOWER_EVENT_CALLBACKS_INIT(&power_callbacks);
  power_callbacks.EvtDeviceD0Entry = ImcodesDeviceD0Entry;
  WdfDeviceInitSetPnpPowerEventCallbacks(device_init, &power_callbacks);

  IDD_CX_CLIENT_CONFIG idd_config;
  IDD_CX_CLIENT_CONFIG_INIT(&idd_config);
  idd_config.EvtIddCxAdapterInitFinished = ImcodesAdapterInitFinished;
  idd_config.EvtIddCxParseMonitorDescription =
      ImcodesParseMonitorDescription;
  idd_config.EvtIddCxMonitorGetDefaultDescriptionModes =
      ImcodesGetDefaultModes;
  idd_config.EvtIddCxMonitorQueryTargetModes = ImcodesQueryTargetModes;
  idd_config.EvtIddCxAdapterCommitModes = ImcodesAdapterCommitModes;
  idd_config.EvtIddCxMonitorAssignSwapChain = ImcodesAssignSwapChain;
  idd_config.EvtIddCxMonitorUnassignSwapChain = ImcodesUnassignSwapChain;
  NTSTATUS status = IddCxDeviceInitConfig(device_init, &idd_config);
  if (!NT_SUCCESS(status)) return status;

  WDF_OBJECT_ATTRIBUTES attributes;
  WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, DeviceContextWrapper);
  attributes.EvtCleanupCallback = ImcodesDeviceContextCleanup;
  WDFDEVICE device = nullptr;
  status = WdfDeviceCreate(&device_init, &attributes, &device);
  if (!NT_SUCCESS(status)) return status;
  status = IddCxDeviceInitialize(device);
  if (!NT_SUCCESS(status)) return status;
  auto* wrapper = WdfObjectGet_DeviceContextWrapper(device);
  wrapper->context = new (std::nothrow) DeviceContext(device);
  return wrapper->context ? STATUS_SUCCESS : STATUS_INSUFFICIENT_RESOURCES;
}

_Use_decl_annotations_ NTSTATUS ImcodesDeviceD0Entry(
    WDFDEVICE device,
    WDF_POWER_DEVICE_STATE previous_state) {
  UNREFERENCED_PARAMETER(previous_state);
  auto* wrapper = WdfObjectGet_DeviceContextWrapper(device);
  if (!wrapper || !wrapper->context) return STATUS_INVALID_DEVICE_STATE;
  wrapper->context->InitializeAdapter();
  return STATUS_SUCCESS;
}

namespace imcodes::virtual_display {

Direct3DDevice::Direct3DDevice(LUID source_luid)
    : adapter_luid(source_luid) {}

HRESULT Direct3DDevice::Initialize() {
  HRESULT result = CreateDXGIFactory2(0, IID_PPV_ARGS(&factory));
  if (FAILED(result)) return result;
  result = factory->EnumAdapterByLuid(adapter_luid, IID_PPV_ARGS(&adapter));
  if (FAILED(result)) return result;
  return D3D11CreateDevice(
      adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
      &device, nullptr, &context);
}

SwapChainProcessor::SwapChainProcessor(
    IDDCX_SWAPCHAIN swap_chain,
    std::shared_ptr<Direct3DDevice> device,
    HANDLE frame_event)
    : swap_chain_(swap_chain),
      device_(std::move(device)),
      frame_event_(frame_event) {
  terminate_event_.Attach(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  if (terminate_event_.Get()) {
    thread_.Attach(CreateThread(nullptr, 0, RunThread, this, 0, nullptr));
  }
}

SwapChainProcessor::~SwapChainProcessor() {
  if (terminate_event_.Get()) SetEvent(terminate_event_.Get());
  if (thread_.Get()) WaitForSingleObject(thread_.Get(), INFINITE);
  if (swap_chain_) {
    WdfObjectDelete(reinterpret_cast<WDFOBJECT>(swap_chain_));
    swap_chain_ = nullptr;
  }
}

DWORD CALLBACK SwapChainProcessor::RunThread(LPVOID argument) {
  reinterpret_cast<SwapChainProcessor*>(argument)->Run();
  return 0;
}

void SwapChainProcessor::Run() {
  DWORD task_index = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Distribution", &task_index);
  RunCore();
  if (swap_chain_) {
    WdfObjectDelete(reinterpret_cast<WDFOBJECT>(swap_chain_));
    swap_chain_ = nullptr;
  }
  if (task) AvRevertMmThreadCharacteristics(task);
}

void SwapChainProcessor::RunCore() {
  if (!swap_chain_ || !device_ || !terminate_event_.Get()) return;
  ComPtr<IDXGIDevice> dxgi_device;
  if (FAILED(device_->device.As(&dxgi_device))) return;
  IDARG_IN_SWAPCHAINSETDEVICE set_device{};
  set_device.pDevice = dxgi_device.Get();
  if (FAILED(IddCxSwapChainSetDevice(swap_chain_, &set_device))) return;

  for (;;) {
    ComPtr<IDXGIResource> frame;
    IDARG_OUT_RELEASEANDACQUIREBUFFER acquired{};
    const HRESULT result =
        IddCxSwapChainReleaseAndAcquireBuffer(swap_chain_, &acquired);
    if (result == E_PENDING) {
      HANDLE waits[] = {frame_event_, terminate_event_.Get()};
      const DWORD wait = WaitForMultipleObjects(
          ARRAYSIZE(waits), waits, FALSE, 50);
      if (wait == WAIT_OBJECT_0 || wait == WAIT_TIMEOUT) continue;
      break;
    }
    if (FAILED(result)) break;
    frame.Attach(acquired.MetaData.pSurface);
    // This IDD provides the Windows desktop surface. The active-user media
    // worker consumes the same virtual output through Desktop Duplication, so
    // the driver only needs to complete this OS-owned swap-chain promptly.
    frame.Reset();
    if (FAILED(IddCxSwapChainFinishedProcessingFrame(swap_chain_))) break;
  }
}

void MonitorContext::AssignSwapChain(IDDCX_SWAPCHAIN swap_chain,
                                     LUID render_adapter,
                                     HANDLE frame_event) {
  processor_.reset();
  auto device = std::make_shared<Direct3DDevice>(render_adapter);
  if (FAILED(device->Initialize())) {
    WdfObjectDelete(reinterpret_cast<WDFOBJECT>(swap_chain));
    return;
  }
  processor_ =
      std::make_unique<SwapChainProcessor>(swap_chain, device, frame_event);
}

MonitorContext::~MonitorContext() { processor_.reset(); }

void MonitorContext::UnassignSwapChain() { processor_.reset(); }

void DeviceContext::InitializeAdapter() {
  IDDCX_ADAPTER_CAPS capabilities{};
  capabilities.Size = sizeof(capabilities);
  capabilities.MaxMonitorsSupported = 1;
  capabilities.EndPointDiagnostics.Size =
      sizeof(capabilities.EndPointDiagnostics);
  capabilities.EndPointDiagnostics.GammaSupport =
      IDDCX_FEATURE_IMPLEMENTATION_NONE;
  capabilities.EndPointDiagnostics.TransmissionType =
      IDDCX_TRANSMISSION_TYPE_WIRED_OTHER;
  capabilities.EndPointDiagnostics.pEndPointFriendlyName =
      L"IM.codes Headless Display";
  capabilities.EndPointDiagnostics.pEndPointManufacturerName = L"IM.codes";
  capabilities.EndPointDiagnostics.pEndPointModelName =
      L"Virtual Display";
  IDDCX_ENDPOINT_VERSION version{};
  version.Size = sizeof(version);
  version.MajorVer = 1;
  capabilities.EndPointDiagnostics.pFirmwareVersion = &version;
  capabilities.EndPointDiagnostics.pHardwareVersion = &version;

  WDF_OBJECT_ATTRIBUTES attributes;
  WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, DeviceContextWrapper);
  IDARG_IN_ADAPTER_INIT input{};
  input.WdfDevice = device_;
  input.pCaps = &capabilities;
  input.ObjectAttributes = &attributes;
  IDARG_OUT_ADAPTER_INIT output{};
  const NTSTATUS status = IddCxAdapterInitAsync(&input, &output);
  if (NT_SUCCESS(status)) {
    adapter_ = output.AdapterObject;
    WdfObjectGet_DeviceContextWrapper(adapter_)->context = this;
  }
}

NTSTATUS DeviceContext::FinishInitialization() {
  WDF_OBJECT_ATTRIBUTES attributes;
  WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, MonitorContextWrapper);
  attributes.EvtCleanupCallback = ImcodesMonitorContextCleanup;
  IDDCX_MONITOR_INFO monitor{};
  monitor.Size = sizeof(monitor);
  // Match Microsoft's production IddCx sample semantics: an indirect monitor
  // is an externally connected target, even when it has no physical cable.
  // Reporting it as INTERNAL leaves targetAvailable=false on Windows 10
  // desktop systems and makes both CCD and legacy display activation fail.
  monitor.MonitorType = DISPLAYCONFIG_OUTPUT_TECHNOLOGY_HDMI;
  monitor.ConnectorIndex = 0;
  monitor.MonitorContainerId = kMonitorContainerId;
  monitor.MonitorDescription.Size = sizeof(monitor.MonitorDescription);
  // IddCx 1.2 represents an EDID-less monitor as an EDID description with no
  // payload. This keeps the driver loadable on supported Windows 10 hosts.
  monitor.MonitorDescription.Type = IDDCX_MONITOR_DESCRIPTION_TYPE_EDID;
  monitor.MonitorDescription.DataSize = 0;
  monitor.MonitorDescription.pData = nullptr;
  IDARG_IN_MONITORCREATE input{};
  input.ObjectAttributes = &attributes;
  input.pMonitorInfo = &monitor;
  IDARG_OUT_MONITORCREATE output{};
  NTSTATUS status = IddCxMonitorCreate(adapter_, &input, &output);
  if (!NT_SUCCESS(status)) return status;
  auto* wrapper = WdfObjectGet_MonitorContextWrapper(output.MonitorObject);
  wrapper->context = new (std::nothrow) MonitorContext(output.MonitorObject);
  if (!wrapper->context) {
    WdfObjectDelete(reinterpret_cast<WDFOBJECT>(output.MonitorObject));
    return STATUS_INSUFFICIENT_RESOURCES;
  }
  IDARG_OUT_MONITORARRIVAL arrival{};
  return IddCxMonitorArrival(output.MonitorObject, &arrival);
}

}  // namespace imcodes::virtual_display

_Use_decl_annotations_ NTSTATUS ImcodesAdapterInitFinished(
    IDDCX_ADAPTER adapter,
    const IDARG_IN_ADAPTER_INIT_FINISHED* input) {
  if (!NT_SUCCESS(input->AdapterInitStatus)) return STATUS_SUCCESS;
  auto* wrapper = WdfObjectGet_DeviceContextWrapper(adapter);
  return wrapper && wrapper->context
             ? wrapper->context->FinishInitialization()
             : STATUS_INVALID_DEVICE_STATE;
}

_Use_decl_annotations_ NTSTATUS ImcodesAdapterCommitModes(
    IDDCX_ADAPTER adapter,
    const IDARG_IN_COMMITMODES* input) {
  UNREFERENCED_PARAMETER(adapter);
  UNREFERENCED_PARAMETER(input);
  return STATUS_SUCCESS;
}

_Use_decl_annotations_ NTSTATUS ImcodesParseMonitorDescription(
    const IDARG_IN_PARSEMONITORDESCRIPTION* input,
    IDARG_OUT_PARSEMONITORDESCRIPTION* output) {
  UNREFERENCED_PARAMETER(input);
  output->MonitorModeBufferOutputCount = 0;
  return STATUS_NOT_SUPPORTED;
}

_Use_decl_annotations_ NTSTATUS ImcodesGetDefaultModes(
    IDDCX_MONITOR monitor,
    const IDARG_IN_GETDEFAULTDESCRIPTIONMODES* input,
    IDARG_OUT_GETDEFAULTDESCRIPTIONMODES* output) {
  UNREFERENCED_PARAMETER(monitor);
  output->DefaultMonitorModeBufferOutputCount =
      static_cast<UINT>(imcodes::virtual_display::kModes.size());
  if (input->DefaultMonitorModeBufferInputCount == 0) return STATUS_SUCCESS;
  if (input->DefaultMonitorModeBufferInputCount <
      imcodes::virtual_display::kModes.size()) {
    return STATUS_BUFFER_TOO_SMALL;
  }
  for (size_t index = 0; index < imcodes::virtual_display::kModes.size();
       ++index) {
    input->pDefaultMonitorModes[index] = imcodes::virtual_display::MonitorMode(
        imcodes::virtual_display::kModes[index]);
  }
  output->PreferredMonitorModeIdx = 0;
  return STATUS_SUCCESS;
}

_Use_decl_annotations_ NTSTATUS ImcodesQueryTargetModes(
    IDDCX_MONITOR monitor,
    const IDARG_IN_QUERYTARGETMODES* input,
    IDARG_OUT_QUERYTARGETMODES* output) {
  UNREFERENCED_PARAMETER(monitor);
  output->TargetModeBufferOutputCount =
      static_cast<UINT>(imcodes::virtual_display::kModes.size());
  if (input->TargetModeBufferInputCount == 0) return STATUS_SUCCESS;
  if (input->TargetModeBufferInputCount <
      imcodes::virtual_display::kModes.size()) {
    return STATUS_BUFFER_TOO_SMALL;
  }
  for (size_t index = 0; index < imcodes::virtual_display::kModes.size();
       ++index) {
    input->pTargetModes[index] = imcodes::virtual_display::TargetMode(
        imcodes::virtual_display::kModes[index]);
  }
  return STATUS_SUCCESS;
}

_Use_decl_annotations_ NTSTATUS ImcodesAssignSwapChain(
    IDDCX_MONITOR monitor,
    const IDARG_IN_SETSWAPCHAIN* input) {
  auto* wrapper = WdfObjectGet_MonitorContextWrapper(monitor);
  if (!wrapper || !wrapper->context) return STATUS_INVALID_DEVICE_STATE;
  wrapper->context->AssignSwapChain(input->hSwapChain,
                                    input->RenderAdapterLuid,
                                    input->hNextSurfaceAvailable);
  return STATUS_SUCCESS;
}

_Use_decl_annotations_ NTSTATUS ImcodesUnassignSwapChain(
    IDDCX_MONITOR monitor) {
  auto* wrapper = WdfObjectGet_MonitorContextWrapper(monitor);
  if (!wrapper || !wrapper->context) return STATUS_INVALID_DEVICE_STATE;
  wrapper->context->UnassignSwapChain();
  return STATUS_SUCCESS;
}
