import 'package:flutter/services.dart';

import 'api.dart';

enum GoogleFlow {
  signIn('/mobile/auth/google/return'),
  gmail('/mobile/gmail/return');

  const GoogleFlow(this.returnPath);
  final String returnPath;
}

const _browser = MethodChannel('co.com.styleplus.mailgasto/google_browser');

Future<void> openGoogleAuthorization(
  Uri authorization,
  Uri origin,
  GoogleFlow flow,
) async {
  try {
    await _browser.invokeMethod<void>('open', {
      'url': authorization.toString(),
      'returnUrl': origin.replace(path: flow.returnPath).toString(),
    });
  } on PlatformException {
    throw const ApiFailure('No pudimos abrir la autorización de Google.');
  }
}
