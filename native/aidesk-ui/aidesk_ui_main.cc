#include "aidesk_ui.h"

#include <cstdlib>
#include <string>

int main(int argc, char** argv) {
  std::string bootstrap = imcodes::aidesk::ui::DefaultLocalManagementBootstrapPath();
  for (int index = 1; index + 1 < argc; ++index) {
    if (std::string(argv[index]) == "--bootstrap") bootstrap = argv[++index];
  }
  imcodes::aidesk::ui::AideskWindow window(
      std::move(bootstrap), imcodes::aidesk::ui::DetectLocale());
  return window.Run(argc, argv);
}
