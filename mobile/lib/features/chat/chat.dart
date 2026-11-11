import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/design.dart';
import '../../core/format.dart';
import '../../core/widgets.dart';
import '../auth/auth.dart';
import '../expenses/finance.dart';

typedef Conversation = ({String id, String createdAt});
typedef Turn = ({
  String question,
  String answer,
  String? action,
  Map<String, String> range,
});
typedef ChatState = ({
  List<Conversation> conversations,
  String? selected,
  List<Turn> turns,
});

final chatRepositoryProvider = Provider((ref) {
  ref.watch(authProvider.select((auth) => auth.asData?.value?.id));
  return ChatRepository(ref.watch(apiProvider));
});
final chatProvider =
    AsyncNotifierProvider.autoDispose<ChatViewModel, ChatState>(
      ChatViewModel.new,
    );

class ChatRepository {
  ChatRepository(this.api);
  final ApiClient api;

  Conversation _conversation(Json json) =>
      (id: json['id'] as String, createdAt: json['created_at'] as String);

  Future<List<Conversation>> conversations() async =>
      (await api.list('chat/sessions')).map(_conversation).toList();

  Future<Conversation> create() async =>
      _conversation(await api.object('chat/sessions', method: 'POST'));

  Future<List<Turn>> turns(String id) async => (await api.list(
    'chat/sessions/${Uri.encodeComponent(id)}/messages',
  )).map((row) => _turn(row['question'] as String, row)).toList();

  Future<Turn> send(String id, String message) async => _turn(
    message,
    await api.object(
      'chat/sessions/${Uri.encodeComponent(id)}/messages',
      method: 'POST',
      body: {'message': message},
    ),
  );

  Turn _turn(String question, Json row) => (
    question: question,
    answer: row['answer'] as String,
    action: row['action'] as String?,
    range: {
      for (final entry in ((row['range'] as Json?) ?? const {}).entries)
        if (entry.value is String) entry.key: entry.value as String,
    },
  );
}

class ChatViewModel extends AsyncNotifier<ChatState> {
  ChatRepository get _repository => ref.read(chatRepositoryProvider);

  @override
  Future<ChatState> build() async => (
    conversations: await ref.watch(chatRepositoryProvider).conversations(),
    selected: null,
    turns: <Turn>[],
  );

  Future<void> open(String? id) async {
    final current = state.requireValue;
    final turns = id == null ? <Turn>[] : await _repository.turns(id);
    if (ref.mounted) {
      state = AsyncData((
        conversations: current.conversations,
        selected: id,
        turns: turns,
      ));
    }
  }

  Future<void> send(String question) async {
    var current = state.requireValue;
    final repository = _repository;
    var selected = current.selected;
    if (selected == null) {
      final conversation = await repository.create();
      if (!ref.mounted) return;
      selected = conversation.id;
      current = (
        conversations: [conversation, ...current.conversations],
        selected: selected,
        turns: [],
      );
      state = AsyncData(current);
    }
    final turn = await repository.send(selected, question);
    if (ref.mounted) {
      state = AsyncData((
        conversations: current.conversations,
        selected: selected,
        turns: [...current.turns, turn],
      ));
    }
  }
}

class ChatScreen extends ConsumerStatefulWidget {
  const ChatScreen({super.key});

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _latestTurn = GlobalKey();
  bool _busy = false;

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _act(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } catch (error) {
      if (mounted) showMessage(context, failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _send() async {
    final message = _input.text.trim();
    if (message.isEmpty || message.length > 1000) return;
    FocusScope.of(context).unfocus();
    await _act(() async {
      await ref.read(chatProvider.notifier).send(message);
      if (mounted) {
        _input.clear();
        _showLatest();
      }
    });
  }

  Future<void> _open(String? id) => _act(() async {
    await ref.read(chatProvider.notifier).open(id);
    if (!mounted) return;
    _input.clear();
    _showLatest();
  });

  void _showLatest() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final target = _latestTurn.currentContext;
      if (target != null) {
        Scrollable.ensureVisible(
          target,
          alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
        );
      } else {
        final empty =
            ref.read(chatProvider).asData?.value.turns.isEmpty ?? true;
        _scroll.jumpTo(empty ? 0 : _scroll.position.maxScrollExtent);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final chat = ref.watch(chatProvider);
    final data = chat.asData?.value;
    return Scaffold(
      appBar: brandBar(),
      body: Padding(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: CustomScrollView(
                controller: _scroll,
                slivers: [
                  SliverToBoxAdapter(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const PageHeading(
                          'Asistente',
                          eyebrow: 'CONSULTAS',
                          description:
                              'Pregunta por tus ingresos y gastos registrados.',
                        ),
                        const SizedBox(height: 7),
                        if (data != null) _conversationControls(data),
                        if (_busy || chat.isLoading) ...[
                          const SizedBox(height: 6),
                          const LinearProgressIndicator(
                            semanticsLabel: 'Cargando conversación',
                            minHeight: 4,
                            borderRadius: BorderRadius.all(Radius.circular(4)),
                          ),
                        ],
                        const SizedBox(height: 12),
                        if (chat.hasError)
                          AppPanel(
                            child: RetryMessage(
                              chat.error!,
                              () => ref.invalidate(chatProvider),
                            ),
                          )
                        else if (data != null && data.turns.isEmpty)
                          const AppNotice(
                            icon: Icons.forum_outlined,
                            title: 'Empieza una conversación',
                            description:
                                'Consulta tus totales o compara los movimientos del periodo.',
                          ),
                      ],
                    ),
                  ),
                  if (data != null) ...[
                    SliverList.builder(
                      itemCount: data.turns.length,
                      itemBuilder: (context, index) => _ChatTurn(
                        data.turns[index],
                        key: index == data.turns.length - 1
                            ? _latestTurn
                            : null,
                      ),
                    ),
                    SliverFillRemaining(
                      hasScrollBody: false,
                      child: Align(
                        alignment: Alignment.bottomLeft,
                        child: _suggestions(),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: Semantics(
                    label: 'Pregunta por tus movimientos',
                    child: TextField(
                      key: const ValueKey('chat-question'),
                      controller: _input,
                      enabled: data != null && !_busy,
                      minLines: 1,
                      maxLines: 3,
                      maxLength: 1000,
                      decoration: const InputDecoration(
                        hintText: 'Pregunta por tus movimientos',
                        counterText: '',
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox.square(
                  dimension: 48,
                  child: IconButton.filled(
                    tooltip: 'Enviar',
                    style: IconButton.styleFrom(
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(13),
                      ),
                    ),
                    onPressed: data == null || _busy ? null : _send,
                    icon: const Icon(Icons.send_outlined, size: 21),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _conversationControls(ChatState value) => Wrap(
    spacing: 8,
    runSpacing: 4,
    crossAxisAlignment: WrapCrossAlignment.center,
    children: [
      PopupMenuButton<String>(
        tooltip: 'Abrir conversaciones',
        enabled: !_busy,
        initialValue: value.selected ?? '',
        child: const FilterLabel(
          'Conversaciones',
          icon: Icons.forum_outlined,
          highlighted: true,
        ),
        itemBuilder: (_) => [
          const PopupMenuItem(value: '', child: Text('Nueva conversación')),
          for (final item in value.conversations)
            PopupMenuItem(
              value: item.id,
              child: Text(syncLabel(item.createdAt)),
            ),
        ],
        onSelected: (id) => _open(id.isEmpty ? null : id),
      ),
      OutlinedButton.icon(
        onPressed: _busy ? null : () => _open(null),
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.muted,
          side: const BorderSide(color: AppColors.border),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          minimumSize: const Size(0, 34),
          iconSize: 15,
          textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
        ),
        icon: const Icon(Icons.add_rounded),
        label: const Text('Nuevo chat'),
      ),
    ],
  );

  Widget _suggestions() => Padding(
    padding: const EdgeInsets.only(top: 6),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Sugerencias', style: Theme.of(context).textTheme.labelMedium),
        const SizedBox(height: 3),
        Wrap(
          spacing: 6,
          children: [
            for (final (prompt, icon) in const [
              ('¿Cuánto ingresó este mes?', Icons.south_west_rounded),
              ('Compara mis ingresos y gastos', Icons.bar_chart_rounded),
              (
                '¿Cuánto gasté en alimentación este mes?',
                Icons.north_east_rounded,
              ),
            ])
              ActionChip(
                avatar: Icon(icon, size: 15, color: AppColors.accent),
                backgroundColor: AppColors.blueTint,
                side: BorderSide.none,
                labelPadding: const EdgeInsets.only(right: 5),
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                labelStyle: Theme.of(
                  context,
                ).textTheme.labelSmall?.copyWith(color: AppColors.accent),
                label: Text(prompt),
                onPressed: _busy ? null : () => _input.text = prompt,
              ),
          ],
        ),
      ],
    ),
  );
}

class _ChatTurn extends StatelessWidget {
  const _ChatTurn(this.turn, {super.key});
  final Turn turn;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final comparison = _comparison(turn.answer);
    final range = turn.range;
    final from = range['from'];
    final to = range['to'];
    final period =
        from != null &&
            to != null &&
            DateTime.tryParse(from) != null &&
            DateTime.tryParse(to) != null
        ? periodLabel(from, to)
        : comparison?.period;
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: Alignment.centerRight,
            child: FractionallySizedBox(
              widthFactor: .87,
              alignment: Alignment.centerRight,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: AppColors.blueTint,
                  borderRadius: BorderRadius.circular(17),
                ),
                child: Text(
                  turn.question,
                  style: text.bodyMedium?.copyWith(color: AppColors.accent),
                ),
              ),
            ),
          ),
          const SizedBox(height: 14),
          AppPanel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const IconTile(Icons.auto_awesome_outlined, size: 29),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        turn.action == 'analysis'
                            ? 'Resumen del periodo'
                            : 'MailGasto IA',
                        style: text.titleMedium,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 9),
                if (comparison != null) ...[
                  Text(
                    comparison.values.length == 1
                        ? '${period ?? comparison.period} · ${comparison.values.single.currency}'
                        : period ?? comparison.period,
                    style: text.bodySmall,
                  ),
                  for (final (index, series) in comparison.values.indexed) ...[
                    if (index > 0) const Divider(height: 18),
                    const SizedBox(height: 7),
                    if (comparison.values.length > 1) ...[
                      Align(
                        alignment: Alignment.centerLeft,
                        child: AppBadge(series.currency),
                      ),
                      const SizedBox(height: 4),
                    ],
                    _line(
                      context,
                      'Ingresos',
                      series.income,
                      series.currency,
                      AppColors.income,
                    ),
                    _line(
                      context,
                      'Gastos',
                      series.expense,
                      series.currency,
                      AppColors.expense,
                    ),
                    _line(
                      context,
                      'Balance del periodo',
                      series.balance,
                      series.currency,
                      AppColors.ink,
                      signed: true,
                    ),
                  ],
                ] else
                  Text(turn.answer, style: text.bodyMedium),
                if (turn.action == 'register') ...[
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: () => context.push('/history/new'),
                    icon: const Icon(Icons.add_rounded),
                    label: const Text('Registrar movimiento'),
                  ),
                ],
                if (turn.action == 'analysis' && range.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: () =>
                        context.go(financePath('/analysis', range)),
                    icon: const Icon(Icons.bar_chart_rounded),
                    label: const Text('Ver análisis'),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _line(
    BuildContext context,
    String label,
    BigInt amount,
    String currency,
    Color color, {
    bool signed = false,
  }) {
    final style = Theme.of(context).textTheme.titleMedium?.copyWith(
      color: color,
      fontFeatures: tabularFigures,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: TrailingRow(
        crossAxisAlignment: CrossAxisAlignment.start,
        leading: Text(label, style: style),
        trailing: Text(
          '${signed && amount > BigInt.zero ? '+ ' : ''}${displayMoney(amount, currency)}',
          semanticsLabel: money(amount, currency),
          textAlign: TextAlign.end,
          style: style,
        ),
      ),
    );
  }
}

typedef _ChatAmounts = ({
  String currency,
  BigInt income,
  BigInt expense,
  BigInt balance,
});

final _comparisonAnswer = RegExp(
  r'^Total de ingresos y gastos \(([^)]+)\): (.+)\.$',
);
final _comparisonAmounts = RegExp(
  r'^(COP|USD|EUR) — Ingresos (\d[\d.]*,\d{2}), gastos (\d[\d.]*,\d{2}), balance ([−-]?\d[\d.]*,\d{2})$',
);

// Format only the server's known comparison template. Leave other answers intact.
({String period, List<_ChatAmounts> values})? _comparison(String answer) {
  final match = _comparisonAnswer.firstMatch(answer);
  if (match == null) return null;
  final values = <_ChatAmounts>[];
  BigInt? minor(String value) => BigInt.tryParse(
    value.replaceAll(RegExp(r'[.,]'), '').replaceAll('−', '-'),
  );
  for (final text in match[2]!.split(' · ')) {
    final row = _comparisonAmounts.firstMatch(text);
    if (row == null) return null;
    final income = minor(row[2]!);
    final expense = minor(row[3]!);
    final balance = minor(row[4]!);
    if (income == null || expense == null || balance == null) return null;
    values.add((
      currency: row[1]!,
      income: income,
      expense: expense,
      balance: balance,
    ));
  }
  return (period: match[1]!, values: values);
}
