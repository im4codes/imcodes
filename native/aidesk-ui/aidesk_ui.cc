#include "aidesk_ui.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <utility>
#include <vector>

#include <FL/Fl.H>
#include <FL/Fl_Box.H>
#include <FL/Fl_Button.H>
#include <FL/Fl_Double_Window.H>
#include <FL/Fl_Scroll.H>
#include <FL/fl_ask.H>
#include <FL/filename.H>

#include "accessibility_bridge.h"

namespace imcodes::aidesk::ui {
namespace common = remote_desktop::common;
namespace {

constexpr Fl_Color kBackground = 0x10182100;
constexpr Fl_Color kCard = 0x18253200;
constexpr Fl_Color kText = 0xedf8ff00;
constexpr Fl_Color kMuted = 0x9fb1c300;
constexpr Fl_Color kReady = 0x34d39900;
constexpr Fl_Color kWarning = 0xf5bd4f00;
constexpr Fl_Color kDanger = 0xfb718500;

struct AwakePayload {
  AideskWindow* window;
  SessionUpdate update;
};

std::int64_t NowMilliseconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string Label(Locale locale, Text text) {
  return std::string(Translate(locale, text));
}

void StyleButton(Fl_Button* button, bool dangerous = false) {
  button->box(FL_ROUNDED_BOX);
  button->color(dangerous ? fl_rgb_color(80, 34, 49) : fl_rgb_color(27, 54, 75));
  button->labelcolor(kText);
  button->selection_color(dangerous ? kDanger : fl_rgb_color(56, 189, 248));
}

}  // namespace

struct AideskWindow::ConnectionWidgets {
  AideskWindow* self;
  std::string id;
};

AideskWindow::AideskWindow(std::string bootstrap_path, Locale locale)
    : locale_(locale) {
  Fl::scheme("gtk+");
  auto window = std::make_unique<Fl_Double_Window>(720, 590);
  window->copy_label(Label(locale_, Text::kProductName).c_str());
  window->color(kBackground);

  auto* title = new Fl_Box(24, 18, 672, 34);
  title->copy_label(Label(locale_, Text::kProductName).c_str());
  title->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
  title->labelfont(FL_BOLD);
  title->labelsize(24);
  title->labelcolor(kText);

  status_ = new Fl_Box(24, 60, 672, 42);
  status_->box(FL_ROUNDED_BOX);
  status_->color(kCard);
  status_->labelcolor(kWarning);
  status_->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
  status_->labelsize(15);

  auto* id_label = new Fl_Box(24, 118, 180, 24);
  id_label->copy_label(Label(locale_, Text::kPublicId).c_str());
  id_label->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
  id_label->labelcolor(kMuted);
  public_id_ = new Fl_Box(24, 145, 500, 42, "—");
  public_id_->box(FL_ROUNDED_BOX);
  public_id_->color(kCard);
  public_id_->labelcolor(kText);
  public_id_->labelfont(FL_COURIER_BOLD);
  public_id_->labelsize(20);
  public_id_->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
  copy_ = new Fl_Button(540, 145, 156, 42);
  copy_->copy_label(Label(locale_, Text::kCopy).c_str());
  StyleButton(copy_);
  copy_->shortcut(FL_CTRL + 'c');
  copy_->callback([](Fl_Widget*, void* context) {
    auto* self = static_cast<AideskWindow*>(context);
    if (!self->snapshot_) return;
    const std::string& id = self->snapshot_->public_node_id;
    Fl::copy(id.data(), static_cast<int>(id.size()), 1);
    self->copy_->copy_label(Label(self->locale_, Text::kCopied).c_str());
  }, this);

  auto* connections_label = new Fl_Box(24, 204, 672, 28);
  connections_label->copy_label(Label(locale_, Text::kConnections).c_str());
  connections_label->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
  connections_label->labelfont(FL_BOLD);
  connections_label->labelsize(18);
  connections_label->labelcolor(kText);
  connections_ = new Fl_Scroll(24, 238, 672, 214);
  connections_->box(FL_ROUNDED_BOX);
  connections_->color(kCard);
  connections_->type(Fl_Scroll::VERTICAL_ALWAYS);
  empty_ = new Fl_Box(connections_->x() + 16, connections_->y() + 18, 620, 40);
  empty_->copy_label(Label(locale_, Text::kNoConnections).c_str());
  empty_->labelcolor(kMuted);
  connections_->end();

  pause_ = new Fl_Button(24, 470, 210, 42);
  pause_->copy_label(Label(locale_, Text::kPause).c_str());
  StyleButton(pause_);
  pause_->shortcut(FL_ALT + 'p');
  pause_->callback([](Fl_Widget*, void* context) {
    auto* self = static_cast<AideskWindow*>(context);
    self->Send(self->snapshot_ && self->snapshot_->paused
                   ? common::LocalManagementAction::kResume
                   : common::LocalManagementAction::kPause);
  }, this);
  stop_all_ = new Fl_Button(246, 470, 210, 42);
  stop_all_->copy_label(Label(locale_, Text::kStopAll).c_str());
  StyleButton(stop_all_, true);
  stop_all_->shortcut(FL_ALT + 's');
  stop_all_->callback([](Fl_Widget*, void* context) {
    auto* self = static_cast<AideskWindow*>(context);
    if (self->Confirm(Text::kStopAllConfirm))
      self->Send(common::LocalManagementAction::kStopAll);
  }, this);
  manage_ = new Fl_Button(468, 470, 110, 42);
  manage_->copy_label(Label(locale_, Text::kWebManagement).c_str());
  StyleButton(manage_);
  manage_->shortcut(FL_ALT + 'm');
  manage_->callback([](Fl_Widget*, void* context) {
    auto* self = static_cast<AideskWindow*>(context);
    if (self->snapshot_) fl_open_uri(self->snapshot_->management_url.c_str(), nullptr, 0);
  }, this);
  share_ = new Fl_Button(590, 470, 106, 42);
  share_->copy_label(Label(locale_, Text::kShare).c_str());
  StyleButton(share_);
  share_->shortcut(FL_ALT + 'h');
  share_->callback([](Fl_Widget*, void* context) {
    auto* self = static_cast<AideskWindow*>(context);
    if (self->snapshot_) fl_open_uri(self->snapshot_->share_url.c_str(), nullptr, 0);
  }, this);

  window->end();
  window->resizable(connections_);
  window_ = std::move(window);
  session_ = std::make_unique<LocalManagementSession>(std::move(bootstrap_path),
      [this](SessionUpdate update) {
        Fl::awake(&AideskWindow::OnAwake, new AwakePayload{this, std::move(update)});
      });
}

AideskWindow::~AideskWindow() {
  Fl::remove_timeout(&AideskWindow::OnTimer, this);
  if (session_) session_->Stop();
}

int AideskWindow::Run(int argc, char** argv) {
  (void)argc;
  (void)argv;
  // Register FLTK's cross-thread wake channel before the IPC worker starts.
  // Without this call Fl::awake() updates can remain queued indefinitely on
  // platforms whose FLTK backend does not initialize threading implicitly.
  Fl::lock();
  window_->show();
  accessibility_ = CreateAccessibilityBridge(window_.get());
  Rebuild();
  session_->Start();
  Fl::add_timeout(1.0, &AideskWindow::OnTimer, this);
  return Fl::run();
}

void AideskWindow::OnAwake(void* context) {
  std::unique_ptr<AwakePayload> payload(static_cast<AwakePayload*>(context));
  payload->window->ApplyUpdate(std::move(payload->update));
}

void AideskWindow::OnTimer(void* context) {
  auto* self = static_cast<AideskWindow*>(context);
  self->UpdateDurations();
  Fl::repeat_timeout(1.0, &AideskWindow::OnTimer, context);
}

void AideskWindow::ApplyUpdate(SessionUpdate update) {
  session_state_ = update.state;
  if (update.snapshot) snapshot_ = std::move(update.snapshot);
  if (update.ack && !update.ack->ok) error_ = update.ack->error;
  else if (!update.error.empty()) error_ = std::move(update.error);
  else if (update.snapshot || (update.ack && update.ack->ok)) error_.clear();
  Rebuild();
}

bool AideskWindow::Confirm(Text message) {
  const std::string prompt = Label(locale_, message);
  return fl_choice("%s",
                   Label(locale_, Text::kCancel).c_str(), nullptr,
                   Label(locale_, Text::kConfirmAgain).c_str(), prompt.c_str()) == 2;
}

void AideskWindow::Send(common::LocalManagementAction action,
                        std::string connection_id) {
  if (!snapshot_ || !session_->SendAction(action, snapshot_->revision,
                                          std::move(connection_id))) return;
  status_->copy_label(Label(locale_, Text::kActionPending).c_str());
  status_->labelcolor(kWarning);
  window_->redraw();
}

void AideskWindow::Rebuild() {
  std::string status;
  Fl_Color status_color = kWarning;
  if (session_state_ == SessionState::kVersionMismatch) {
    status = Label(locale_, Text::kVersionMismatch);
    status_color = kDanger;
  } else if (!snapshot_) {
    status = session_state_ == SessionState::kStarting
        ? Label(locale_, Text::kServiceStarting)
        : Label(locale_, Text::kServiceUnavailable);
  } else if (snapshot_->paused) {
    status = Label(locale_, Text::kAccessPaused);
  } else {
    switch (snapshot_->service_state) {
      case common::LocalManagementServiceState::kReady:
        status = Label(locale_, Text::kServiceReady); status_color = kReady; break;
      case common::LocalManagementServiceState::kStarting:
        status = Label(locale_, Text::kServiceStarting); break;
      case common::LocalManagementServiceState::kStopped:
        status = Label(locale_, Text::kServiceStopped); break;
      case common::LocalManagementServiceState::kRepairRequired:
        status = Label(locale_, Text::kServiceRepairRequired); status_color = kDanger; break;
      case common::LocalManagementServiceState::kVersionMismatch:
        status = Label(locale_, Text::kVersionMismatch); status_color = kDanger; break;
    }
  }
  if (!error_.empty() && snapshot_) status += " · " + Label(locale_, Text::kActionFailed);
  status_->copy_label(status.c_str());
  status_->labelcolor(status_color);
  public_id_->copy_label(snapshot_ ? snapshot_->public_node_id.c_str() : "—");
  const bool ready = snapshot_.has_value() && session_state_ == SessionState::kConnected;
  for (Fl_Button* button : {copy_, pause_, stop_all_, manage_, share_}) {
    ready ? button->activate() : button->deactivate();
  }
  pause_->copy_label(Label(locale_, snapshot_ && snapshot_->paused
      ? Text::kResume : Text::kPause).c_str());

  connections_->clear();
  connection_actions_.clear();
  connections_->begin();
  if (!snapshot_ || snapshot_->connections.empty()) {
    empty_ = new Fl_Box(connections_->x() + 16, connections_->y() + 18, 620, 40);
    empty_->copy_label(Label(locale_, Text::kNoConnections).c_str());
    empty_->labelcolor(kMuted);
  } else {
    int y = connections_->y() + 12;
    for (const auto& connection : snapshot_->connections) {
      const std::string role = Label(locale_, connection.role ==
          common::LocalManagementConnectionRole::kControl
              ? Text::kControlling : Text::kViewing);
      const std::string detail = connection.label + "  ·  " + role + "  ·  " +
          Label(locale_, Text::kConnectedAt) + " " + FormatLocalTime(connection.connected_at_ms) +
          "  ·  " + Label(locale_, Text::kDuration) + " " +
          FormatDuration(std::max<std::int64_t>(connection.duration_ms,
              NowMilliseconds() - connection.connected_at_ms));
      auto* row = new Fl_Box(connections_->x() + 12, y, 500, 48);
      row->copy_label(detail.c_str());
      row->box(FL_ROUNDED_BOX);
      row->color(fl_rgb_color(25, 39, 52));
      row->labelcolor(kText);
      row->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE | FL_ALIGN_WRAP);
      auto* disconnect = new Fl_Button(connections_->x() + 526, y + 6, 118, 36);
      disconnect->copy_label(Label(locale_, Text::kDisconnect).c_str());
      StyleButton(disconnect, true);
      disconnect->callback([](Fl_Widget*, void* raw) {
        auto* context = static_cast<ConnectionWidgets*>(raw);
        if (context->self->Confirm(Text::kDisconnectConfirm))
          context->self->Send(common::LocalManagementAction::kDisconnect, context->id);
      }, nullptr);
      connection_actions_.push_back(std::make_unique<ConnectionWidgets>(
          ConnectionWidgets{this, connection.id}));
      disconnect->user_data(connection_actions_.back().get());
      y += 58;
    }
  }
  connections_->end();
  connections_->redraw();
  PublishAccessibility();
  window_->redraw();
}

void AideskWindow::UpdateDurations() {
  if (snapshot_ && !snapshot_->connections.empty()) Rebuild();
}

void AideskWindow::PublishAccessibility() {
  if (!accessibility_) return;
  std::vector<AccessibleItem> items;
  items.push_back({AccessibleRole::kStatus, "service-status",
                   status_->label()});
  items.push_back({AccessibleRole::kText, "public-id",
                   Label(locale_, Text::kPublicId), public_id_->label()});
  items.push_back({AccessibleRole::kButton, "copy", Label(locale_, Text::kCopy), {},
                   copy_->active() != 0, [button = copy_] { button->do_callback(); },
                   copy_->x(), copy_->y(), copy_->w(), copy_->h()});
  items.push_back({AccessibleRole::kButton, "pause", pause_->label(), {},
                   pause_->active() != 0, [button = pause_] { button->do_callback(); },
                   pause_->x(), pause_->y(), pause_->w(), pause_->h()});
  items.push_back({AccessibleRole::kButton, "stop-all", Label(locale_, Text::kStopAll), {},
                   stop_all_->active() != 0, [button = stop_all_] { button->do_callback(); },
                   stop_all_->x(), stop_all_->y(), stop_all_->w(), stop_all_->h()});
  items.push_back({AccessibleRole::kButton, "manage", Label(locale_, Text::kWebManagement), {},
                   manage_->active() != 0, [button = manage_] { button->do_callback(); },
                   manage_->x(), manage_->y(), manage_->w(), manage_->h()});
  items.push_back({AccessibleRole::kButton, "share", Label(locale_, Text::kShare), {},
                   share_->active() != 0, [button = share_] { button->do_callback(); },
                   share_->x(), share_->y(), share_->w(), share_->h()});
  items.push_back({AccessibleRole::kList, "connections", Label(locale_, Text::kConnections),
                   snapshot_ ? std::to_string(snapshot_->connections.size()) : "0"});
  if (snapshot_) {
    for (std::size_t index = 0; index < snapshot_->connections.size(); ++index) {
      const auto& connection = snapshot_->connections[index];
      items.push_back({AccessibleRole::kListItem, "connection-" + connection.id,
                       connection.label,
                       Label(locale_, connection.role == common::LocalManagementConnectionRole::kControl
                           ? Text::kControlling : Text::kViewing)});
      items.push_back({AccessibleRole::kButton, "disconnect-" + connection.id,
                       Label(locale_, Text::kDisconnect), connection.label, true,
                       [this, id = connection.id] {
                         if (Confirm(Text::kDisconnectConfirm))
                           Send(common::LocalManagementAction::kDisconnect, id);
                       }, connections_->x() + 526,
                       connections_->y() + 18 + static_cast<int>(index) * 58,
                       118, 36});
    }
  }
  accessibility_->Update(items);
}

}  // namespace imcodes::aidesk::ui
