#ifndef IMCODES_AIDESK_UI_AIDESK_UI_H_
#define IMCODES_AIDESK_UI_AIDESK_UI_H_

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "aidesk_ui_strings.h"
#include "local_management_session.h"

class Fl_Box;
class Fl_Button;
class Fl_Group;
class Fl_Scroll;
class Fl_Window;

namespace imcodes::aidesk::ui {

class AccessibilityBridge;

class AideskWindow final {
 public:
  AideskWindow(std::string bootstrap_path, Locale locale);
  ~AideskWindow();
  int Run(int argc, char** argv);

 private:
  struct ConnectionWidgets;
  void ApplyUpdate(SessionUpdate update);
  void Rebuild();
  void UpdateDurations();
  void PublishAccessibility();
  void Send(remote_desktop::common::LocalManagementAction action,
            std::string connection_id = {});
  bool Confirm(Text message);
  static void OnAwake(void* context);
  static void OnTimer(void* context);

  Locale locale_;
  SessionState session_state_ = SessionState::kStarting;
  std::optional<remote_desktop::common::LocalManagementSnapshot> snapshot_;
  std::string error_;
  std::unique_ptr<Fl_Window> window_;
  Fl_Box* status_ = nullptr;
  Fl_Box* public_id_ = nullptr;
  Fl_Button* copy_ = nullptr;
  Fl_Button* pause_ = nullptr;
  Fl_Button* stop_all_ = nullptr;
  Fl_Button* manage_ = nullptr;
  Fl_Button* share_ = nullptr;
  Fl_Scroll* connections_ = nullptr;
  Fl_Box* empty_ = nullptr;
  std::unique_ptr<AccessibilityBridge> accessibility_;
  std::unique_ptr<LocalManagementSession> session_;
  std::vector<std::unique_ptr<ConnectionWidgets>> connection_actions_;
};

}  // namespace imcodes::aidesk::ui

#endif  // IMCODES_AIDESK_UI_AIDESK_UI_H_
