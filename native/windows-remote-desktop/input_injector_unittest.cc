#include "third_party/imcodes_remote_desktop/input_injector.h"

#include <algorithm>
#include <vector>

#include "test/gtest.h"

namespace imcodes::rd {
namespace {

class RecordingInput {
 public:
  UINT Send(UINT count, LPINPUT inputs, int size) {
    if (size != sizeof(INPUT) || fail_next_) {
      fail_next_ = false;
      return 0;
    }
    events.insert(events.end(), inputs, inputs + count);
    return count;
  }

  bool fail_next_ = false;
  std::vector<INPUT> events;
};

TEST(InputArbiterTest, KeepsConcurrentControllerKeyOwnershipIndependent) {
  RecordingInput recording;
  InputArbiter input([&](UINT count, LPINPUT values, int size) {
    return recording.Send(count, values, size);
  });

  EXPECT_TRUE(input.KeyDown("peer-a", "ControlLeft", false));
  EXPECT_TRUE(input.KeyDown("peer-b", "ControlLeft", false));
  ASSERT_EQ(recording.events.size(), 1u);
  EXPECT_EQ(recording.events[0].ki.dwFlags & KEYEVENTF_KEYUP, 0u);

  input.ReleaseOwner("peer-a");
  EXPECT_EQ(recording.events.size(), 1u);
  input.ReleaseOwner("peer-b");
  ASSERT_EQ(recording.events.size(), 2u);
  EXPECT_NE(recording.events[1].ki.dwFlags & KEYEVENTF_KEYUP, 0u);
}

TEST(InputArbiterTest, ReportsInteractiveDesktopAvailability) {
  RecordingInput recording;
  bool available = false;
  InputArbiter input(
      [&](UINT count, LPINPUT values, int size) {
        return recording.Send(count, values, size);
      },
      [&] { return available; });

  EXPECT_FALSE(input.Available());
  available = true;
  EXPECT_TRUE(input.Available());
}

TEST(InputArbiterTest, MovesPointerInExactSelectedDisplayPixels) {
  RecordingInput recording;
  std::vector<POINT> positions;
  InputArbiter input(
      [&](UINT count, LPINPUT values, int size) {
        return recording.Send(count, values, size);
      },
      [] { return true; },
      [&](int x, int y) {
        positions.push_back(POINT{x, y});
        return true;
      });
  DisplayInfo display;
  display.desktop_rect = RECT{-3840, 100, 0, 2260};
  display.width = 3840;
  display.height = 2160;

  EXPECT_TRUE(input.Move(display, 0.5, 0.5));
  EXPECT_TRUE(input.Move(display, 1.0, 1.0));
  ASSERT_EQ(positions.size(), 2u);
  EXPECT_EQ(positions[0].x, -1920);
  EXPECT_EQ(positions[0].y, 1180);
  EXPECT_EQ(positions[1].x, -1);
  EXPECT_EQ(positions[1].y, 2259);
  EXPECT_TRUE(recording.events.empty());
}

TEST(InputArbiterTest, RetriesFailedFinalKeyReleaseDuringTeardown) {
  RecordingInput recording;
  InputArbiter input([&](UINT count, LPINPUT values, int size) {
    return recording.Send(count, values, size);
  });

  ASSERT_TRUE(input.KeyDown("peer-a", "KeyA", false));
  recording.fail_next_ = true;
  EXPECT_FALSE(input.KeyUp("peer-a", "KeyA"));
  EXPECT_EQ(recording.events.size(), 1u);
  EXPECT_TRUE(input.ReleaseOwner("peer-a"));
  ASSERT_EQ(recording.events.size(), 2u);
  EXPECT_NE(recording.events[1].ki.dwFlags & KEYEVENTF_KEYUP, 0u);
}

TEST(InputArbiterTest, RollsBackFailedFirstPressAndRejectsUnknownInput) {
  RecordingInput recording;
  InputArbiter input([&](UINT count, LPINPUT values, int size) {
    return recording.Send(count, values, size);
  });

  recording.fail_next_ = true;
  EXPECT_FALSE(input.ButtonDown("peer-a", "left"));
  EXPECT_TRUE(input.ButtonDown("peer-b", "left"));
  EXPECT_EQ(recording.events.size(), 1u);
  EXPECT_FALSE(input.KeyDown("peer-a", "MetaLeft", false));
  EXPECT_FALSE(input.KeyDown("peer-a", "F1garbage", false));
  EXPECT_FALSE(input.ButtonDown("peer-a", "sixth"));
  input.ReleaseOwner("peer-b");
  EXPECT_EQ(recording.events.size(), 2u);
}

TEST(InputArbiterTest, RetainsAndRetriesReleaseThatFailsDuringTeardown) {
  RecordingInput recording;
  InputArbiter input([&](UINT count, LPINPUT values, int size) {
    return recording.Send(count, values, size);
  });

  ASSERT_TRUE(input.ButtonDown("peer-a", "middle"));
  recording.fail_next_ = true;
  EXPECT_FALSE(input.ReleaseOwner("peer-a"));
  ASSERT_EQ(recording.events.size(), 1u);
  EXPECT_TRUE(input.RetryPendingReleases());
  ASSERT_EQ(recording.events.size(), 2u);
  EXPECT_NE(recording.events[1].mi.dwFlags & MOUSEEVENTF_MIDDLEUP, 0u);
}

TEST(InputArbiterTest, CrashRecoveryReleasesOnlySupportedKeysAndButtons) {
  RecordingInput recording;
  EXPECT_TRUE(ReleaseAllSupportedInput(
      [&](UINT count, LPINPUT values, int size) {
        return recording.Send(count, values, size);
      }));
  EXPECT_GT(recording.events.size(), 60u);
  EXPECT_TRUE(std::all_of(recording.events.begin(), recording.events.end(),
                          [](const INPUT& input) {
    return input.type == INPUT_KEYBOARD
               ? (input.ki.dwFlags & KEYEVENTF_KEYUP) != 0
               : input.type == INPUT_MOUSE &&
                     (input.mi.dwFlags & (MOUSEEVENTF_LEFTUP |
                                          MOUSEEVENTF_MIDDLEUP |
                                          MOUSEEVENTF_RIGHTUP |
                                          MOUSEEVENTF_XUP)) != 0;
  }));
}

TEST(InputArbiterTest, CopyShortcutAlwaysReleasesControlAndC) {
  std::vector<INPUT> dispatched;
  InputArbiter input([&](UINT count, LPINPUT values, int size) {
    EXPECT_EQ(size, static_cast<int>(sizeof(INPUT)));
    dispatched.insert(dispatched.end(), values, values + count);
    return count;
  });
  EXPECT_TRUE(input.CopyShortcut("clipboard-owner"));
  ASSERT_EQ(dispatched.size(), 4u);
  EXPECT_EQ(dispatched[0].ki.dwFlags & KEYEVENTF_KEYUP, 0u);
  EXPECT_EQ(dispatched[1].ki.dwFlags & KEYEVENTF_KEYUP, 0u);
  EXPECT_NE(dispatched[2].ki.dwFlags & KEYEVENTF_KEYUP, 0u);
  EXPECT_NE(dispatched[3].ki.dwFlags & KEYEVENTF_KEYUP, 0u);
}

}  // namespace
}  // namespace imcodes::rd
