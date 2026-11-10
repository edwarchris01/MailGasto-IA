import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../auth/auth.dart';
import 'expenses.dart';

const currencies = {'COP': 'COP', 'USD': 'USD', 'EUR': 'EUR'};
const movementSources = {'email': 'Correo', 'manual': 'Manual'};

typedef FinanceRange = ({String from, String to, String currency});
typedef MovementPage = ({List<Movement> items, int page, bool hasMore});
typedef MovementFilter = ({
  String? from,
  String? to,
  String? currency,
  String? category,
  String? source,
  String? direction,
});

FinanceRange currentRange([String currency = 'COP']) {
  final dates = dateFilter(monthRange(bogotaNow()));
  return (from: dates.from, to: dates.to, currency: currency);
}

String financePath(String path, Map<String, String> query) =>
    Uri(path: path, queryParameters: query.isEmpty ? null : query).toString();

Map<String, String> rangeQuery(FinanceRange range) => {
  'from': range.from,
  'to': range.to,
  'currency': range.currency,
};

String requestId() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

final financeRepositoryProvider = Provider((ref) {
  ref.watch(authProvider.select((session) => session.asData?.value?.id));
  return FinanceRepository(ref.watch(apiProvider));
});

final analyticsProvider = FutureProvider.autoDispose
    .family<Analytics, FinanceRange>(
      (ref, range) => ref.watch(financeRepositoryProvider).analytics(range),
    );
final movementProvider = FutureProvider.autoDispose.family<Movement, String>(
  (ref, id) => ref.watch(financeRepositoryProvider).detail(id),
);
final movementsProvider = AsyncNotifierProvider.autoDispose
    .family<MovementsModel, MovementPage, MovementFilter>(MovementsModel.new);

void refreshFinance(WidgetRef ref) {
  ref.invalidate(analyticsProvider);
  ref.invalidate(movementsProvider);
  ref.invalidate(movementProvider);
}

class Movement {
  Movement.fromJson(Json row)
    : id = row['id'] as String,
      source = row['source'] as String,
      income = row['direction'] == 'income',
      minor = BigInt.parse(row['amount_minor'] as String),
      date = row['transaction_date'] as String,
      currency = row['currency'] as String,
      category = row['category'] as String,
      method = row['payment_method'] as String?,
      description = row['description'] as String?,
      provider = row['provider'] as String?,
      matches = ((row['matches'] as List?) ?? const [])
          .cast<Json>()
          .map(Movement.fromJson)
          .toList();

  final String id, source, date, currency, category;
  final String? method, description, provider;
  final bool income;
  final BigInt minor;
  final List<Movement> matches;

  bool get manual => source == 'manual';
  String get kind => income ? 'Ingreso' : 'Gasto';
  String get title =>
      description ?? '$kind ${manual ? 'manual' : 'por correo'}';
  String get signedAmount => '${income ? '+' : '−'} ${money(minor, currency)}';
}

class Bucket {
  Bucket.fromJson(Json row)
    : from = row['from'] as String,
      to = row['to'] as String,
      income = BigInt.parse(row['incomeMinor'] as String),
      expense = BigInt.parse(row['expenseMinor'] as String);

  final String from, to;
  final BigInt income, expense;
  String get label =>
      from == to ? dayLabel(from) : '${dayLabel(from)} – ${dayLabel(to)}';
}

typedef Breakdown = ({String key, BigInt amount});

class Analytics {
  Analytics.fromJson(Json data)
    : income = BigInt.parse(data['incomeMinor'] as String),
      expense = BigInt.parse(data['expenseMinor'] as String),
      balance = BigInt.parse(data['balanceMinor'] as String),
      series = (data['series'] as List)
          .cast<Json>()
          .map(Bucket.fromJson)
          .toList(),
      expenseCategories = _breakdown(data['expenseCategories'] as List),
      incomeSources = _breakdown(data['incomeSources'] as List);

  final BigInt income, expense, balance;
  final List<Bucket> series;
  final List<Breakdown> expenseCategories, incomeSources;
  bool get empty => income == BigInt.zero && expense == BigInt.zero;

  static List<Breakdown> _breakdown(List values) => values
      .cast<Json>()
      .map(
        (row) => (
          key: row['key'] as String,
          amount: BigInt.parse(row['amountMinor'] as String),
        ),
      )
      .toList();
}

class FinanceRepository {
  FinanceRepository(this.api);
  final ApiClient api;

  Future<Analytics> analytics(FinanceRange range) async => Analytics.fromJson(
    await api.object('analytics', query: rangeQuery(range)),
  );

  Future<MovementPage> list(MovementFilter filter, {int page = 1}) async {
    final data = await api.object(
      'movements',
      query: {
        'from': ?filter.from,
        'to': ?filter.to,
        'currency': ?filter.currency,
        'category': ?filter.category,
        'source': ?filter.source,
        'direction': ?filter.direction,
        'page': page,
      },
    );
    return (
      items: (data['items'] as List)
          .cast<Json>()
          .map(Movement.fromJson)
          .toList(),
      page: data['page'] as int,
      hasMore: data['hasMore'] as bool,
    );
  }

  Future<Movement> detail(String id) async =>
      Movement.fromJson(await api.object('movements/$id'));

  Future<String> create(Json data, String key) async =>
      (await api.object(
            'movements',
            method: 'POST',
            body: {...data, 'requestId': key},
          ))['id']
          as String;

  Future<void> edit(String id, Json data) =>
      api.request('movements/$id', method: 'PATCH', body: data);

  Future<void> remove(String id) =>
      api.request('movements/$id', method: 'DELETE');
}

class MovementsModel extends AsyncNotifier<MovementPage> {
  MovementsModel(this.filter);
  final MovementFilter filter;
  bool _busy = false;

  @override
  Future<MovementPage> build() =>
      ref.watch(financeRepositoryProvider).list(filter);

  Future<void> more() async {
    final current = state.asData?.value;
    if (current == null || !current.hasMore || _busy) return;
    _busy = true;
    try {
      final next = await ref
          .read(financeRepositoryProvider)
          .list(filter, page: current.page + 1);
      if (!ref.mounted || !identical(current, state.asData?.value)) return;
      final ids = current.items.map((item) => item.id).toSet();
      state = AsyncData((
        items: [
          ...current.items,
          ...next.items.where((item) => ids.add(item.id)),
        ],
        page: next.page,
        hasMore: next.hasMore,
      ));
    } finally {
      _busy = false;
    }
  }
}
