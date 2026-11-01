package com.familyframe.shell;

import android.app.admin.DeviceAdminReceiver;

/** Device admin with a single policy (force-lock) so night mode can switch the backlight fully off. */
public class AdminReceiver extends DeviceAdminReceiver {}
