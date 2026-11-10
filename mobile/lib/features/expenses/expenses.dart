import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../auth/auth.dart';

typedef HistoryFilters = ({
  String? from,
  String? to,
  String? category,
  String? status,
});
typedef DateFilter = ({String from, String to});
typedef HistoryPage = ({List<Notice> items, int page, bool hasMore});

final expenseRepositoryProvider = Provider((ref) {
  ref.watch(authProvider.select((auth) => auth.asData?.value?.id));
  return ExpenseRepository(ref.watch(apiProvider));
});

class ExpenseRepository {
  ExpenseRepository(this.api);
  final ApiClient api;

  Future<HistoryPage> history(HistoryFilters filters, {int page = 1}) async {
    final data = await api.object(
      'notices',
      query: {
        'from': ?filters.from,
        'to': ?filters.to,
        'category': ?filters.category,
        'status': ?filters.status,
        'unregistered': 'true',
        'page': page,
      },
    );
    return (
      items: (data['items'] as List).cast<Json>().map(Notice.fromJson).toList(),
      page: data['page'] as int,
      hasMore: data['hasMore'] as bool,
    );
  }

  Future<Notice> detail(String id) async =>
      Notice.fromJson(await api.object('notices/${Uri.encodeComponent(id)}'));
}

class Notice {
  Notice.fromJson(Json row)
    : id = row['id'] as String,
      provider = row['provider'] as String,
      status = row['status'] as String,
      receivedAt = row['received_at'] as String,
      reason = row['reason'] as String?,
      date = row['transaction_date'] as String?,
      currency = row['currency'] as String?,
      minor = BigInt.tryParse(row['amount_minor'] as String? ?? ''),
      paymentMethod = row['payment_method'] as String?,
      category = row['category'] as String?,
      description = row['description'] as String?,
      unconfirmedFields =
          (row['unconfirmed_fields'] as List?)?.cast<String>() ?? const [];

  final String id;
  final String provider;
  final String status;
  final String receivedAt;
  final String? reason;
  final String? date;
  final String? currency;
  final BigInt? minor;
  final String? paymentMethod;
  final String? category;
  final String? description;
  final List<String> unconfirmedFields;

  String get providerLabel => switch (provider) {
    'nequi' => 'Nequi',
    'bancolombia' => 'Bancolombia',
    'other' => 'Otro remitente',
    _ => provider,
  };

  String? get amount =>
      minor == null || currency == null ? null : money(minor!, currency!);

  String get pendingExplanation {
    if (reason == 'unverified_sender') {
      return 'El correo parece confirmar un pago o ingreso. Revisa el mensaje original antes de registrar el movimiento.';
    }
    const labels = {
      'amount': 'monto',
      'currency': 'moneda',
      'date': 'fecha',
      'direction': 'tipo de movimiento',
      'payment_method': 'medio de pago',
    };
    final fields = unconfirmedFields
        .map((field) => labels[field])
        .nonNulls
        .toSet();
    if (fields.isNotEmpty) return 'Datos por confirmar: ${fields.join(', ')}.';
    return switch (reason) {
      'missing_or_ambiguous_fields' =>
        'El aviso contiene datos incompletos o ambiguos.',
      'unconfirmed_extraction' =>
        'No pudimos confirmar los datos extraídos del aviso.',
      _ => 'El aviso requiere revisión.',
    };
  }
}

final noticeProvider = FutureProvider.autoDispose.family<Notice, String>(
  (ref, id) => ref.watch(expenseRepositoryProvider).detail(id),
);

final historyProvider = AsyncNotifierProvider.autoDispose
    .family<HistoryViewModel, HistoryPage, HistoryFilters>(
      HistoryViewModel.new,
    );

class HistoryViewModel extends AsyncNotifier<HistoryPage> {
  HistoryViewModel(this.filters);
  final HistoryFilters filters;
  bool _paging = false;

  @override
  Future<HistoryPage> build() =>
      ref.watch(expenseRepositoryProvider).history(filters);

  Future<void> loadMore() async {
    final current = state.asData?.value;
    if (current == null || !current.hasMore || _paging) return;
    _paging = true;
    try {
      final next = await ref
          .read(expenseRepositoryProvider)
          .history(filters, page: current.page + 1);
      if (!ref.mounted || !identical(state.asData?.value, current)) return;
      final ids = current.items.map((notice) => notice.id).toSet();
      state = AsyncData((
        items: [
          ...current.items,
          ...next.items.where((item) => ids.add(item.id)),
        ],
        page: next.page,
        hasMore: next.hasMore,
      ));
    } finally {
      _paging = false;
    }
  }
}

DateTimeRange monthRange(DateTime today, {bool previous = false}) => previous
    ? DateTimeRange(
        start: DateTime(today.year, today.month - 1),
        end: DateTime(today.year, today.month, 0),
      )
    : DateTimeRange(
        start: DateTime(today.year, today.month),
        end: DateTime(today.year, today.month, today.day),
      );

DateFilter dateFilter(DateTimeRange range) =>
    (from: isoDay(range.start), to: isoDay(range.end));

Future<DateTimeRange?> pickDates(
  BuildContext context, {
  DateTimeRange? initial,
}) => showDateRangePicker(
  context: context,
  firstDate: DateTime(2000),
  lastDate: bogotaNow(),
  initialDateRange: initial,
  currentDate: bogotaNow(),
  helpText: 'Selecciona el periodo',
);
