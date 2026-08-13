# IM.codes headless virtual display

This directory contains the production UMDF IddCx virtual-display driver used
only when no real Windows output produces a bounded first DXGI frame. It is a
small derivative of Microsoft's `video/IndirectDisplay/IddSample` under the
Microsoft Public License; the complete upstream license is retained here.

The release build produces and signs `imcodes-virtual-display.dll`,
`imcodes-virtual-display.inf`, and `imcodes-virtual-display.cat`. The controlled
node installs that prebuilt package during its signed atomic upgrade. It never
installs the WDK, Visual Studio, npm, Git, source code, or codecs on an end-user
machine.

The software device is created by the verified remote-desktop worker only from
the SYSTEM node process. Its lifetime is handle-bound: closing stdin, controller
exit, or node crash closes the software-device handle and Windows removes the
virtual monitor. Physical and third-party display devices are never changed.
