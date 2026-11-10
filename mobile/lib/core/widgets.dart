import 'package:flutter/material.dart';

import 'api.dart';
import 'format.dart';

class RetryMessage extends StatelessWidget {
  const RetryMessage(this.error, this.retry, {super.key});
  final Object error;
  final VoidCallback retry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(failureMessage(error), textAlign: TextAlign.center),
          TextButton(onPressed: retry, child: const Text('Reintentar')),
        ],
      ),
    ),
  );
}

class StatusBadge extends StatelessWidget {
  const StatusBadge(this.status, {super.key});
  final String status;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final pending = status == 'pending';
    final error = status == 'error';
    return DecoratedBox(
      decoration: BoxDecoration(
        color: pending
            ? const Color(0xFFFFF1D8)
            : error
            ? const Color(0xFFFDEDEB)
            : colors.secondaryContainer,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        child: Text(
          noticeStatuses[status] ?? 'Estado desconocido',
          style: TextStyle(
            color: pending
                ? const Color(0xFF8A4B08)
                : error
                ? const Color(0xFFB42318)
                : colors.onSecondaryContainer,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

void showMessage(BuildContext context, String message) {
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}
