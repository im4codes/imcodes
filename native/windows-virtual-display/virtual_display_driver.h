// Derived from Microsoft's IddSample (MS-PL); see LICENSE.microsoft.txt.
#pragma once

#include <windows.h>
#include <wudfwdm.h>
#include <wdf.h>
#include <iddcx.h>

#include <avrt.h>
#include <d3d11_2.h>
#include <dxgi1_5.h>
#include <wrl.h>

#include <memory>

namespace Microsoft::WRL::Wrappers {
using Thread = HandleT<HandleTraits::HANDLENullTraits>;
}

namespace imcodes::virtual_display {

struct Direct3DDevice {
  explicit Direct3DDevice(LUID adapter_luid);
  HRESULT Initialize();

  LUID adapter_luid{};
  Microsoft::WRL::ComPtr<IDXGIFactory5> factory;
  Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
  Microsoft::WRL::ComPtr<ID3D11Device> device;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
};

class SwapChainProcessor {
 public:
  SwapChainProcessor(IDDCX_SWAPCHAIN swap_chain,
                     std::shared_ptr<Direct3DDevice> device,
                     HANDLE frame_event);
  ~SwapChainProcessor();

 private:
  static DWORD CALLBACK RunThread(LPVOID argument);
  void Run();
  void RunCore();

  IDDCX_SWAPCHAIN swap_chain_ = nullptr;
  std::shared_ptr<Direct3DDevice> device_;
  HANDLE frame_event_ = nullptr;
  Microsoft::WRL::Wrappers::Thread thread_;
  Microsoft::WRL::Wrappers::Event terminate_event_;
};

class MonitorContext {
 public:
  explicit MonitorContext(IDDCX_MONITOR monitor) : monitor_(monitor) {}
  ~MonitorContext();
  void AssignSwapChain(IDDCX_SWAPCHAIN swap_chain,
                       LUID render_adapter,
                       HANDLE frame_event);
  void UnassignSwapChain();

 private:
  IDDCX_MONITOR monitor_ = nullptr;
  std::unique_ptr<SwapChainProcessor> processor_;
};

class DeviceContext {
 public:
  explicit DeviceContext(WDFDEVICE device) : device_(device) {}
  void InitializeAdapter();
  NTSTATUS FinishInitialization();

 private:
  WDFDEVICE device_ = nullptr;
  IDDCX_ADAPTER adapter_{};
};

}  // namespace imcodes::virtual_display
