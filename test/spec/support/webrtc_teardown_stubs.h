#ifndef IMCODES_TEST_SUPPORT_WEBRTC_TEARDOWN_STUBS_H_
#define IMCODES_TEST_SUPPORT_WEBRTC_TEARDOWN_STUBS_H_

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

// Minimal upstream libwebrtc API stubs so real `pinned_libwebrtc_transport_backend.cc`
// can compile and execute teardown/lifetime tests under macOS ASan + UBSan
// without needing the full 850MB upstream checkout on disk.

#define WEBRTC_VIDEO_CODEC_OK 0
#define WEBRTC_VIDEO_CODEC_ERROR -1
#define WEBRTC_VIDEO_CODEC_ERR_PARAMETER -4

namespace webrtc {

template <typename T>
class scoped_refptr {
 public:
  scoped_refptr() noexcept = default;
  scoped_refptr(std::nullptr_t) noexcept {}
  explicit scoped_refptr(T* ptr) noexcept : ptr_(ptr) {
    if (ptr_) ptr_->AddRef();
  }
  scoped_refptr(const scoped_refptr& other) noexcept : ptr_(other.ptr_) {
    if (ptr_) ptr_->AddRef();
  }
  template <typename U>
  scoped_refptr(const scoped_refptr<U>& other) noexcept : ptr_(other.get()) {
    if (ptr_) ptr_->AddRef();
  }
  scoped_refptr(scoped_refptr&& other) noexcept : ptr_(other.ptr_) {
    other.ptr_ = nullptr;
  }
  template <typename U>
  scoped_refptr(scoped_refptr<U>&& other) noexcept : ptr_(other.release()) {}

  ~scoped_refptr() {
    if (ptr_) ptr_->Release();
  }

  scoped_refptr& operator=(const scoped_refptr& other) noexcept {
    if (ptr_ != other.ptr_) {
      if (other.ptr_) other.ptr_->AddRef();
      T* old = ptr_;
      ptr_ = other.ptr_;
      if (old) old->Release();
    }
    return *this;
  }
  scoped_refptr& operator=(scoped_refptr&& other) noexcept {
    if (this != &other) {
      T* old = ptr_;
      ptr_ = other.ptr_;
      other.ptr_ = nullptr;
      if (old) old->Release();
    }
    return *this;
  }
  scoped_refptr& operator=(std::nullptr_t) noexcept {
    T* old = ptr_;
    ptr_ = nullptr;
    if (old) old->Release();
    return *this;
  }

  T* get() const noexcept { return ptr_; }
  T* operator->() const noexcept { return ptr_; }
  T& operator*() const noexcept { return *ptr_; }
  explicit operator bool() const noexcept { return ptr_ != nullptr; }
  T* release() noexcept {
    T* p = ptr_;
    ptr_ = nullptr;
    return p;
  }
  friend bool operator==(const scoped_refptr& a, std::nullptr_t) noexcept {
    return a.ptr_ == nullptr;
  }
  friend bool operator!=(const scoped_refptr& a, std::nullptr_t) noexcept {
    return a.ptr_ != nullptr;
  }

 private:
  T* ptr_ = nullptr;
};

class RefCountInterface {
 public:
  virtual void AddRef() const = 0;
  virtual int Release() const = 0;
 protected:
  virtual ~RefCountInterface() = default;
};

template <typename T>
class RefCountedObject final : public T {
 public:
  template <typename... Args>
  explicit RefCountedObject(Args&&... args) : T(std::forward<Args>(args)...) {}
  void AddRef() const override {
    ref_count_.fetch_add(1, std::memory_order_relaxed);
  }
  int Release() const override {
    const int rem = ref_count_.fetch_sub(1, std::memory_order_acq_rel) - 1;
    if (rem == 0) delete this;
    return rem;
  }
 private:
  mutable std::atomic<int> ref_count_{0};
};

template <typename T, typename... Args>
scoped_refptr<T> make_ref_counted(Args&&... args) {
  return scoped_refptr<T>(new RefCountedObject<T>(std::forward<Args>(args)...));
}

inline int64_t TimeMicros() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

class Environment {};

enum class MediaType { AUDIO, VIDEO, DATA };

class ObserverInterface {
 public:
  virtual ~ObserverInterface() = default;
};

class RTCError {
 public:
  static RTCError OK() { return RTCError(true); }
  static RTCError Invalid() { return RTCError(false); }
  bool ok() const { return ok_; }
 private:
  explicit RTCError(bool ok) : ok_(ok) {}
  bool ok_ = true;
};

template <typename T>
class RTCErrorOr {
 public:
  RTCErrorOr(T value) : ok_(true), value_(std::move(value)) {}
  RTCErrorOr(RTCError) : ok_(false) {}
  bool ok() const { return ok_; }
  T MoveValue() { return std::move(value_); }
 private:
  bool ok_ = false;
  T value_{};
};

class Thread {
 public:
  static std::unique_ptr<Thread> Create();
  bool Start();
  void Stop();
  bool stopped() const { return stopped_; }
 private:
  bool started_ = false;
  bool stopped_ = false;
};

enum class SdpType { kOffer, kAnswer };
struct SdpParseError {
  std::string line;
  std::string description;
};

class SessionDescriptionInterface {
 public:
  virtual ~SessionDescriptionInterface() = default;
  virtual bool ToString(std::string* out) const {
    if (out) *out = sdp_;
    return !sdp_.empty();
  }
  std::string sdp_;
};

inline std::unique_ptr<SessionDescriptionInterface> CreateSessionDescription(
    SdpType,
    std::string_view sdp,
    SdpParseError*) {
  if (sdp.find("INVALID") != std::string_view::npos) return nullptr;
  auto d = std::make_unique<SessionDescriptionInterface>();
  d->sdp_ = std::string(sdp);
  return d;
}

class IceCandidateInterface {
 public:
  virtual ~IceCandidateInterface() = default;
  virtual std::string sdp_mid() const { return mid_; }
  virtual bool ToString(std::string* out) const {
    if (out) *out = cand_;
    return !cand_.empty();
  }
  std::string mid_;
  std::string cand_;
};

inline IceCandidateInterface* CreateIceCandidate(const std::string& mid,
                                                 int,
                                                 const std::string& sdp,
                                                 SdpParseError*) {
  auto* c = new IceCandidateInterface();
  c->mid_ = mid;
  c->cand_ = sdp;
  return c;
}

class ColorSpace {
 public:
  enum class PrimaryID { kBT709 };
  enum class TransferID { kBT709 };
  enum class MatrixID { kBT709 };
  enum class RangeID { kLimited };
  ColorSpace() = default;
  ColorSpace(PrimaryID, TransferID, MatrixID, RangeID) {}
};

class VideoFrameBuffer : public RefCountInterface {};

class I420Buffer : public VideoFrameBuffer {
 public:
  I420Buffer(int w, int h)
      : w_(w),
        y_(static_cast<std::size_t>(w * h), 0),
        u_(static_cast<std::size_t>((w / 2) * (h / 2)), 128),
        v_(static_cast<std::size_t>((w / 2) * (h / 2)), 128) {}

  static scoped_refptr<I420Buffer> Create(int w, int h) {
    if (w <= 0 || h <= 0) return nullptr;
    return make_ref_counted<I420Buffer>(w, h);
  }
  static void SetBlack(I420Buffer* buf) {
    if (!buf) return;
    std::fill(buf->y_.begin(), buf->y_.end(), 16);
  }

  std::uint8_t* MutableDataY() { return y_.data(); }
  std::uint8_t* MutableDataU() { return u_.data(); }
  std::uint8_t* MutableDataV() { return v_.data(); }
  int StrideY() const { return w_; }
  int StrideU() const { return w_ / 2; }
  int StrideV() const { return w_ / 2; }

 private:
  int w_;
  std::vector<std::uint8_t> y_;
  std::vector<std::uint8_t> u_;
  std::vector<std::uint8_t> v_;
};

class VideoFrame {
 public:
  class Builder {
   public:
    Builder& set_video_frame_buffer(scoped_refptr<VideoFrameBuffer> b) {
      buf_ = std::move(b);
      return *this;
    }
    Builder& set_timestamp_us(int64_t ts) {
      ts_ = ts;
      return *this;
    }
    Builder& set_color_space(const ColorSpace&) { return *this; }
    VideoFrame build() { return VideoFrame(std::move(buf_), ts_); }
   private:
    scoped_refptr<VideoFrameBuffer> buf_;
    int64_t ts_ = 0;
  };
  VideoFrame() = default;
  VideoFrame(scoped_refptr<VideoFrameBuffer> buf, int64_t ts)
      : buf_(std::move(buf)), ts_(ts) {}
  scoped_refptr<VideoFrameBuffer> buf_;
  int64_t ts_ = 0;
};

enum class VideoFrameType { kVideoFrameKey, kVideoFrameDelta };

struct VideoSinkWants {};

template <typename VideoFrameT>
class VideoSinkInterface {
 public:
  virtual ~VideoSinkInterface() = default;
  virtual void OnFrame(const VideoFrameT& frame) = 0;
};

class RecordableEncodedFrame {};

class VideoTrackSourceInterface : public RefCountInterface {
 public:
  enum SourceState { kInitializing, kLive, kEnded, kMuted };
  struct Stats {};
  virtual void AddOrUpdateSink(VideoSinkInterface<VideoFrame>* sink,
                               const VideoSinkWants& wants) = 0;
  virtual void RemoveSink(VideoSinkInterface<VideoFrame>* sink) = 0;
  virtual SourceState state() const = 0;
  virtual bool remote() const = 0;
  virtual bool is_screencast() const = 0;
  virtual std::optional<bool> needs_denoising() const = 0;
  virtual bool GetStats(Stats* stats) = 0;
  virtual void RegisterObserver(ObserverInterface* observer) = 0;
  virtual void UnregisterObserver(ObserverInterface* observer) = 0;
  virtual bool SupportsEncodedOutput() const = 0;
  virtual void GenerateKeyFrame() = 0;
  virtual void AddEncodedSink(VideoSinkInterface<RecordableEncodedFrame>* sink) = 0;
  virtual void RemoveEncodedSink(VideoSinkInterface<RecordableEncodedFrame>* sink) = 0;
};

class VideoTrackInterface : public RefCountInterface {
 public:
  static inline constexpr char kVideoKind[] = "video";
  virtual std::string kind() const { return kVideoKind; }
};

class MediaStreamTrackInterface : public RefCountInterface {
 public:
  static inline constexpr char kVideoKind[] = "video";
  virtual std::string kind() const { return kVideoKind; }
};

struct SdpVideoFormat {
  explicit SdpVideoFormat(std::string n) : name(std::move(n)) {}
  static SdpVideoFormat VP9Profile0() { return SdpVideoFormat("VP9"); }
  static SdpVideoFormat VP8() { return SdpVideoFormat("VP8"); }
  std::string name;
  std::map<std::string, std::string> parameters;
};

struct VideoCodec {
  int width = 0;
  int height = 0;
};

struct CodecSpecificInfo {};

class EncodedImage {
 public:
  std::size_t size() const { return size_; }
  std::size_t size_ = 0;
};

class EncodedImageCallback {
 public:
  struct Result {
    enum Error { OK, ERROR_SEND_FAILED };
    explicit Result(Error e) : error(e) {}
    Error error;
  };
  virtual ~EncodedImageCallback() = default;
  virtual Result OnEncodedImage(const EncodedImage& encoded_image,
                                const CodecSpecificInfo* codec_specific_info) = 0;
  virtual void OnFrameDropped(uint32_t, int, bool) {}
};

class FecControllerOverride {};

class VideoEncoder {
 public:
  struct Settings {
    Settings(int, int cores, int) : number_of_cores(cores) {}
    Settings() = default;
    int number_of_cores = 1;
  };
  struct BitrateAllocation {
    std::uint32_t sum = 0;
    std::uint32_t get_sum_bps() const { return sum; }
  };
  struct RateControlParameters {
    BitrateAllocation bitrate;
  };
  struct LossNotification {};
  struct EncoderInfo {
    std::string implementation_name;
    bool is_hardware_accelerated = false;
    bool supports_native_handle = false;
  };
  virtual ~VideoEncoder() = default;
  virtual void SetFecControllerOverride(FecControllerOverride*) {}
  virtual int InitEncode(const VideoCodec* codec_settings,
                         const Settings& settings) = 0;
  virtual int32_t RegisterEncodeCompleteCallback(
      EncodedImageCallback* callback) = 0;
  virtual int32_t Release() = 0;
  virtual int32_t Encode(const VideoFrame& frame,
                         const std::vector<VideoFrameType>* frame_types) = 0;
  virtual void SetRates(const RateControlParameters& parameters) = 0;
  virtual void OnPacketLossRateUpdate(float) {}
  virtual void OnRttUpdate(int64_t) {}
  virtual void OnLossNotification(const LossNotification&) {}
  virtual EncoderInfo GetEncoderInfo() const = 0;
};

class VideoEncoderFactory {
 public:
  virtual ~VideoEncoderFactory() = default;
  virtual std::vector<SdpVideoFormat> GetSupportedFormats() const = 0;
  virtual std::unique_ptr<VideoEncoder> Create(
      const Environment& env,
      const SdpVideoFormat& format) = 0;
};

class VideoDecoder {};
class VideoDecoderFactory {
 public:
  virtual ~VideoDecoderFactory() = default;
  virtual std::vector<SdpVideoFormat> GetSupportedFormats() const = 0;
  virtual std::unique_ptr<VideoDecoder> Create(
      const Environment& env,
      const SdpVideoFormat& format) = 0;
};

inline std::unique_ptr<VideoEncoder> CreateVp9Encoder(const Environment&, int) {
  return nullptr;
}
inline std::unique_ptr<VideoEncoder> CreateVp8Encoder(const Environment&, int) {
  return nullptr;
}

class AudioDeviceModule : public RefCountInterface {};
namespace webrtc_impl {
template <typename Base>
class AudioDeviceModuleDefault : public Base {};
}  // namespace webrtc_impl
class AudioEncoderFactory {};
class AudioDecoderFactory {};
inline std::unique_ptr<AudioEncoderFactory> CreateBuiltinAudioEncoderFactory() {
  return std::make_unique<AudioEncoderFactory>();
}
inline std::unique_ptr<AudioDecoderFactory> CreateBuiltinAudioDecoderFactory() {
  return std::make_unique<AudioDecoderFactory>();
}

struct DataBuffer {
  explicit DataBuffer(std::string s) : data_str(std::move(s)) {}
  struct DataView {
    const std::uint8_t* data() const { return ptr; }
    std::size_t size() const { return len; }
    const std::uint8_t* ptr = nullptr;
    std::size_t len = 0;
  };
  bool binary = false;
  std::string data_str;
  DataView data{reinterpret_cast<const std::uint8_t*>(data_str.data()),
                data_str.size()};
  std::size_t size() const { return data_str.size(); }
};

class DataChannelObserver {
 public:
  virtual ~DataChannelObserver() = default;
  virtual void OnStateChange() = 0;
  virtual void OnMessage(const DataBuffer& buffer) = 0;
};

class DataChannelInterface : public RefCountInterface {
 public:
  enum DataState { kConnecting, kOpen, kClosing, kClosed };
  virtual std::string label() const { return label_; }
  virtual bool ordered() const { return ordered_; }
  virtual std::optional<int> maxRetransmitsOpt() const { return max_retransmits_; }
  virtual DataState state() const { return state_; }
  virtual std::uint64_t buffered_amount() const { return 0; }
  virtual void RegisterObserver(DataChannelObserver* obs) { observer_ = obs; }
  virtual void UnregisterObserver() { observer_ = nullptr; }
  virtual void Close() { state_ = kClosed; }
  virtual bool Send(const DataBuffer&) { return state_ == kOpen; }

  std::string label_;
  bool ordered_ = true;
  std::optional<int> max_retransmits_;
  DataState state_ = kOpen;
  DataChannelObserver* observer_ = nullptr;
};

struct RtpEncodingParameters {
  std::optional<int> min_bitrate_bps;
  std::optional<int> max_bitrate_bps;
};
struct RtpParameters {
  std::vector<RtpEncodingParameters> encodings;
};
struct RtpCodecCapability {
  std::string name;
};
struct RtpCapabilities {
  std::vector<RtpCodecCapability> codecs;
};

class RtpSenderInterface : public RefCountInterface {
 public:
  virtual scoped_refptr<MediaStreamTrackInterface> track() const { return track_; }
  virtual RtpParameters GetParameters() const { return params_; }
  virtual RTCError SetParameters(const RtpParameters& p) {
    params_ = p;
    return set_ok_ ? RTCError::OK() : RTCError::Invalid();
  }
  scoped_refptr<MediaStreamTrackInterface> track_;
  RtpParameters params_;
  bool set_ok_ = true;
};

class RtpTransceiverInterface : public RefCountInterface {
 public:
  virtual MediaType media_type() const { return MediaType::VIDEO; }
  virtual RTCError SetCodecPreferences(const std::vector<RtpCodecCapability>&) {
    return RTCError::OK();
  }
};

struct BitrateSettings {
  std::optional<int> min_bitrate_bps;
  std::optional<int> start_bitrate_bps;
  std::optional<int> max_bitrate_bps;
};

class SetLocalDescriptionObserverInterface : public RefCountInterface {
 public:
  virtual void OnSetLocalDescriptionComplete(RTCError error) = 0;
};
class SetRemoteDescriptionObserverInterface : public RefCountInterface {
 public:
  virtual void OnSetRemoteDescriptionComplete(RTCError error) = 0;
};
class CreateSessionDescriptionObserver : public RefCountInterface {
 public:
  virtual void OnSuccess(SessionDescriptionInterface* desc) = 0;
  virtual void OnFailure(RTCError error) = 0;
};

enum class IceCandidateType { kHost, kRelay };
class Candidate {
 public:
  IceCandidateType type() const { return type_; }
  IceCandidateType type_ = IceCandidateType::kHost;
};
class CandidatePair {
 public:
  const Candidate& local_candidate() const { return local_; }
  Candidate local_;
};
struct CandidatePairChangeEvent {
  CandidatePair selected_candidate_pair;
};

class RTCStatsReport : public RefCountInterface {
 public:
  template <typename T>
  std::vector<const T*> GetStatsOfType() const {
    return {};
  }
};
class RTCTransportStats {
 public:
  std::string id() const { return "t0"; }
  std::optional<std::uint64_t> bytes_sent{0};
  std::optional<std::uint64_t> bytes_received{0};
};
class RTCStatsCollectorCallback : public RefCountInterface {
 public:
  virtual void OnStatsDelivered(const scoped_refptr<const RTCStatsReport>& report) = 0;
};

class PeerConnectionInterface : public RefCountInterface {
 public:
  enum class SignalingState { kStable };
  enum class PeerConnectionState {
    kNew,
    kConnecting,
    kConnected,
    kDisconnected,
    kFailed,
    kClosed,
  };
  enum class IceGatheringState { kComplete };
  enum class IceConnectionState { kIceConnectionConnected };
  struct IceServer {
    std::vector<std::string> urls;
    std::string username;
    std::string password;
  };
  struct RTCConfiguration {
    int sdp_semantics = 0;
    std::vector<IceServer> servers;
  };
  struct RTCOfferAnswerOptions {};

  virtual RTCErrorOr<scoped_refptr<RtpSenderInterface>> AddTrack(
      scoped_refptr<VideoTrackInterface> track,
      const std::vector<std::string>& streams) = 0;
  virtual std::vector<scoped_refptr<RtpSenderInterface>> GetSenders() const = 0;
  virtual std::vector<scoped_refptr<RtpTransceiverInterface>> GetTransceivers() const = 0;
  virtual void SetRemoteDescription(
      std::unique_ptr<SessionDescriptionInterface> desc,
      scoped_refptr<SetRemoteDescriptionObserverInterface> obs) = 0;
  virtual void CreateAnswer(CreateSessionDescriptionObserver* obs,
                            const RTCOfferAnswerOptions& opts) = 0;
  virtual void SetLocalDescription(
      std::unique_ptr<SessionDescriptionInterface> desc,
      scoped_refptr<SetLocalDescriptionObserverInterface> obs) = 0;
  virtual bool AddIceCandidate(const IceCandidateInterface* cand) = 0;
  virtual RTCError SetBitrate(const BitrateSettings& settings) = 0;
  virtual void GetStats(RTCStatsCollectorCallback* cb) = 0;
  virtual void Close() = 0;
};

namespace SdpSemantics {
inline constexpr int kUnifiedPlan = 1;
}

class PeerConnectionObserver {
 public:
  virtual ~PeerConnectionObserver() = default;
  virtual void OnSignalingChange(PeerConnectionInterface::SignalingState) = 0;
  virtual void OnDataChannel(scoped_refptr<DataChannelInterface> channel) = 0;
  virtual void OnRenegotiationNeeded() = 0;
  virtual void OnIceGatheringChange(PeerConnectionInterface::IceGatheringState) = 0;
  virtual void OnConnectionChange(PeerConnectionInterface::PeerConnectionState) = 0;
  virtual void OnIceConnectionChange(PeerConnectionInterface::IceConnectionState) = 0;
  virtual void OnIceCandidate(const IceCandidateInterface* candidate) = 0;
  virtual void OnIceSelectedCandidatePairChanged(const CandidatePairChangeEvent& event) = 0;
};

struct PeerConnectionDependencies {
  explicit PeerConnectionDependencies(PeerConnectionObserver* obs) : observer(obs) {}
  PeerConnectionObserver* observer = nullptr;
};

class PeerConnectionFactoryInterface : public RefCountInterface {
 public:
  virtual RTCErrorOr<scoped_refptr<PeerConnectionInterface>>
  CreatePeerConnectionOrError(
      const PeerConnectionInterface::RTCConfiguration& configuration,
      PeerConnectionDependencies dependencies) = 0;
  virtual scoped_refptr<VideoTrackInterface> CreateVideoTrack(
      scoped_refptr<VideoTrackSourceInterface> source,
      const std::string& label) = 0;
  virtual RtpCapabilities GetRtpSenderCapabilities(MediaType media_type) const = 0;
};

struct PeerConnectionFactoryDependencies {
  Thread* signaling_thread = nullptr;
  std::unique_ptr<VideoEncoderFactory> video_encoder_factory;
  std::unique_ptr<VideoDecoderFactory> video_decoder_factory;
  scoped_refptr<AudioDeviceModule> adm;
  std::unique_ptr<AudioEncoderFactory> audio_encoder_factory;
  std::unique_ptr<AudioDecoderFactory> audio_decoder_factory;
};

inline void EnableMedia(PeerConnectionFactoryDependencies&) {}
scoped_refptr<PeerConnectionFactoryInterface>
CreateModularPeerConnectionFactory(PeerConnectionFactoryDependencies deps);

}  // namespace webrtc

namespace imcodes::test_stubs {

struct StubControl {
  bool fail_thread_start = false;
  bool fail_create_factory = false;
  bool fail_create_peer = false;
  bool fail_create_video_track = false;
  bool fail_add_track = false;
  bool fail_set_bitrate_limits = false;
  bool hold_encoder_past_close = true;

  std::vector<std::unique_ptr<webrtc::VideoEncoder>> leaked_encoders;
  std::unique_ptr<webrtc::VideoEncoderFactory> last_encoder_factory;
  webrtc::VideoTrackSourceInterface* last_source = nullptr;
  webrtc::PeerConnectionObserver* last_observer = nullptr;
  int close_calls = 0;
};

inline StubControl& Control() {
  static StubControl instance;
  return instance;
}

inline void ResetControl() {
  Control().fail_thread_start = false;
  Control().fail_create_factory = false;
  Control().fail_create_peer = false;
  Control().fail_create_video_track = false;
  Control().fail_add_track = false;
  Control().fail_set_bitrate_limits = false;
  Control().hold_encoder_past_close = true;
  Control().leaked_encoders.clear();
  Control().last_encoder_factory.reset();
  Control().last_source = nullptr;
  Control().last_observer = nullptr;
  Control().close_calls = 0;
}

}  // namespace imcodes::test_stubs

namespace webrtc {

inline std::unique_ptr<Thread> Thread::Create() {
  return std::make_unique<Thread>();
}
inline bool Thread::Start() {
  if (imcodes::test_stubs::Control().fail_thread_start) return false;
  started_ = true;
  return true;
}
inline void Thread::Stop() {
  stopped_ = true;
}

class FakeVideoTrack : public VideoTrackInterface {
 public:
  explicit FakeVideoTrack(scoped_refptr<VideoTrackSourceInterface> src)
      : source_(std::move(src)) {}
  scoped_refptr<VideoTrackSourceInterface> source_;
};

class FakePeerConnection : public PeerConnectionInterface {
 public:
  FakePeerConnection(std::shared_ptr<VideoEncoderFactory> factory,
                     PeerConnectionObserver*)
      : encoder_factory_(std::move(factory)) {}

  RTCErrorOr<scoped_refptr<RtpSenderInterface>> AddTrack(
      scoped_refptr<VideoTrackInterface> track,
      const std::vector<std::string>&) override {
    if (imcodes::test_stubs::Control().fail_add_track) {
      return RTCErrorOr<scoped_refptr<RtpSenderInterface>>(RTCError::Invalid());
    }
    auto sender = make_ref_counted<RtpSenderInterface>();
    auto mt = make_ref_counted<MediaStreamTrackInterface>();
    sender->track_ = mt;
    sender->params_.encodings.push_back(RtpEncodingParameters{});
    sender->set_ok_ = !imcodes::test_stubs::Control().fail_set_bitrate_limits;
    senders_.push_back(sender);
    tracks_.push_back(std::move(track));
    if (encoder_factory_) {
      auto enc = encoder_factory_->Create(Environment{}, SdpVideoFormat("H264"));
      if (enc) {
        VideoCodec codec{1280, 720};
        enc->InitEncode(&codec, VideoEncoder::Settings{0, 2, 0});
        enc->RegisterEncodeCompleteCallback(&dummy_cb_);
        VideoEncoder::RateControlParameters rate;
        rate.bitrate.sum = 2'000'000;
        enc->SetRates(rate);
        if (imcodes::test_stubs::Control().hold_encoder_past_close) {
          imcodes::test_stubs::Control().leaked_encoders.push_back(std::move(enc));
        } else {
          enc->Release();
        }
      }
    }
    return RTCErrorOr<scoped_refptr<RtpSenderInterface>>(sender);
  }

  std::vector<scoped_refptr<RtpSenderInterface>> GetSenders() const override {
    return senders_;
  }
  std::vector<scoped_refptr<RtpTransceiverInterface>> GetTransceivers() const override {
    return {};
  }
  void SetRemoteDescription(
      std::unique_ptr<SessionDescriptionInterface>,
      scoped_refptr<SetRemoteDescriptionObserverInterface> obs) override {
    if (obs) obs->OnSetRemoteDescriptionComplete(RTCError::OK());
  }
  void CreateAnswer(CreateSessionDescriptionObserver* obs,
                    const RTCOfferAnswerOptions&) override {
    if (!obs) return;
    auto* ans = new SessionDescriptionInterface();
    ans->sdp_ = "v=0\r\na=rtpmap:96 H264/90000\r\n";
    obs->OnSuccess(ans);
    obs->Release();
  }
  void SetLocalDescription(
      std::unique_ptr<SessionDescriptionInterface>,
      scoped_refptr<SetLocalDescriptionObserverInterface> obs) override {
    if (obs) obs->OnSetLocalDescriptionComplete(RTCError::OK());
  }
  bool AddIceCandidate(const IceCandidateInterface*) override { return true; }
  RTCError SetBitrate(const BitrateSettings&) override { return RTCError::OK(); }
  void GetStats(RTCStatsCollectorCallback* cb) override {
    if (cb) {
      auto report = make_ref_counted<RTCStatsReport>();
      cb->OnStatsDelivered(report);
    }
  }
  void Close() override {
    imcodes::test_stubs::Control().close_calls++;
    senders_.clear();
    tracks_.clear();
  }

 private:
  class DummyCb final : public EncodedImageCallback {
   public:
    Result OnEncodedImage(const EncodedImage&, const CodecSpecificInfo*) override {
      return Result(Result::OK);
    }
  } dummy_cb_;
  std::shared_ptr<VideoEncoderFactory> encoder_factory_;
  std::vector<scoped_refptr<RtpSenderInterface>> senders_;
  std::vector<scoped_refptr<VideoTrackInterface>> tracks_;
};

class FakePeerConnectionFactory : public PeerConnectionFactoryInterface {
 public:
  explicit FakePeerConnectionFactory(std::shared_ptr<VideoEncoderFactory> enc)
      : encoder_factory_(std::move(enc)) {}

  RTCErrorOr<scoped_refptr<PeerConnectionInterface>>
  CreatePeerConnectionOrError(
      const PeerConnectionInterface::RTCConfiguration&,
      PeerConnectionDependencies dependencies) override {
    if (imcodes::test_stubs::Control().fail_create_peer) {
      return RTCErrorOr<scoped_refptr<PeerConnectionInterface>>(RTCError::Invalid());
    }
    imcodes::test_stubs::Control().last_observer = dependencies.observer;
    return RTCErrorOr<scoped_refptr<PeerConnectionInterface>>(
        make_ref_counted<FakePeerConnection>(encoder_factory_,
                                             dependencies.observer));
  }

  scoped_refptr<VideoTrackInterface> CreateVideoTrack(
      scoped_refptr<VideoTrackSourceInterface> source,
      const std::string&) override {
    imcodes::test_stubs::Control().last_source = source.get();
    if (imcodes::test_stubs::Control().fail_create_video_track) return nullptr;
    return make_ref_counted<FakeVideoTrack>(std::move(source));
  }

  RtpCapabilities GetRtpSenderCapabilities(MediaType) const override {
    return {};
  }

 private:
  std::shared_ptr<VideoEncoderFactory> encoder_factory_;
};

inline scoped_refptr<PeerConnectionFactoryInterface>
CreateModularPeerConnectionFactory(PeerConnectionFactoryDependencies deps) {
  if (imcodes::test_stubs::Control().fail_create_factory) return nullptr;
  std::shared_ptr<VideoEncoderFactory> shared_factory(
      std::move(deps.video_encoder_factory));
  return make_ref_counted<FakePeerConnectionFactory>(std::move(shared_factory));
}

}  // namespace webrtc

#endif  // IMCODES_TEST_SUPPORT_WEBRTC_TEARDOWN_STUBS_H_
