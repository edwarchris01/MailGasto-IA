import 'package:flutter/material.dart';

import '../../core/design.dart';
import 'expenses.dart';

AppTone noticeTone(String status) => switch (status) {
  'pending' => AppTone.warning,
  'error' => AppTone.danger,
  'registered' => AppTone.income,
  _ => AppTone.info,
};

IconData noticeIcon(String status) => switch (status) {
  'pending' => Icons.mark_email_unread_outlined,
  'error' => Icons.error_outline,
  'processing' => Icons.schedule_outlined,
  _ => Icons.mail_outline,
};

String noticePreview(Notice notice) => switch (notice.status) {
  'pending'
      when notice.unconfirmedFields.length == 1 &&
          notice.unconfirmedFields.single == 'amount' =>
    'Monto por confirmar',
  'pending' when notice.reason == 'unverified_sender' =>
    'Remitente por revisar',
  'pending' => 'Datos por confirmar',
  'processing' => 'Validando el aviso',
  'error' when notice.reason == 'mailbox_disconnected' =>
    'Se desvinculó el buzón',
  'error' => 'Fallo de procesamiento',
  _ => notice.description ?? 'Aviso por correo',
};
