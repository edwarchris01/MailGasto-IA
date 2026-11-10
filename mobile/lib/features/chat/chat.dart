import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/widgets.dart';

typedef Conversation = ({String id, String createdAt});
typedef Turn = ({String question, String answer});
typedef ChatState = ({
  List<Conversation> conversations,
  String? selected,
  List<Turn> turns,
});

final chatRepositoryProvider = Provider(
  (ref) => ChatRepository(ref.watch(apiProvider)),
);
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

  Future<List<Turn>> turns(String id) async =>
      (await api.list('chat/sessions/${Uri.encodeComponent(id)}/messages'))
          .map(
            (row) => (
              question: row['question'] as String,
              answer: row['answer'] as String,
            ),
          )
          .toList();

  Future<String> send(String id, String message) async =>
      (await api.object(
            'chat/sessions/${Uri.encodeComponent(id)}/messages',
            method: 'POST',
            body: {'message': message},
          ))['answer']
          as String;
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
    final answer = await repository.send(selected, question);
    if (ref.mounted) {
      state = AsyncData((
        conversations: current.conversations,
        selected: selected,
        turns: [...current.turns, (question: question, answer: answer)],
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
  bool _busy = false;

  @override
  void dispose() {
    _input.dispose();
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
      if (mounted) _input.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final chat = ref.watch(chatProvider);
    final colors = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Asistente')),
      body: chat.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) =>
            RetryMessage(error, () => ref.invalidate(chatProvider)),
        data: (value) => SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: DropdownButton<String>(
                        value: value.selected ?? '',
                        isExpanded: true,
                        items: [
                          const DropdownMenuItem(
                            value: '',
                            child: Text('Nueva conversación'),
                          ),
                          for (final item in value.conversations)
                            DropdownMenuItem(
                              value: item.id,
                              child: Text(syncLabel(item.createdAt)),
                            ),
                        ],
                        onChanged: _busy
                            ? null
                            : (id) => _act(() async {
                                await ref
                                    .read(chatProvider.notifier)
                                    .open(id == '' ? null : id);
                                if (mounted) _input.clear();
                              }),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Nueva conversación',
                      onPressed: _busy
                          ? null
                          : () => _act(() async {
                              await ref.read(chatProvider.notifier).open(null);
                              if (mounted) _input.clear();
                            }),
                      icon: const Icon(Icons.add_comment_outlined),
                    ),
                  ],
                ),
                if (_busy) const LinearProgressIndicator(),
                Expanded(
                  child: value.turns.isEmpty
                      ? ListView(
                          children: [
                            const SizedBox(height: 20),
                            const Text(
                              'Pregunta por los gastos registrados en tu cuenta.',
                            ),
                            const SizedBox(height: 12),
                            Align(
                              alignment: Alignment.centerLeft,
                              child: ActionChip(
                                label: const Text(
                                  '¿Cuánto gasté en alimentación este mes?',
                                ),
                                onPressed: _busy
                                    ? null
                                    : () {
                                        _input.text =
                                            '¿Cuánto gasté en alimentación este mes?';
                                      },
                              ),
                            ),
                          ],
                        )
                      : ListView.builder(
                          reverse: true,
                          itemCount: value.turns.length,
                          itemBuilder: (context, index) {
                            final turn =
                                value.turns[value.turns.length - index - 1];
                            return Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Card(
                                  color: colors.secondaryContainer,
                                  child: Padding(
                                    padding: const EdgeInsets.all(14),
                                    child: Text(turn.question),
                                  ),
                                ),
                                Card(
                                  child: Padding(
                                    padding: const EdgeInsets.all(14),
                                    child: Text(turn.answer),
                                  ),
                                ),
                                const SizedBox(height: 10),
                              ],
                            );
                          },
                        ),
                ),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: TextField(
                        key: const ValueKey('chat-question'),
                        controller: _input,
                        enabled: !_busy,
                        minLines: 1,
                        maxLines: 3,
                        maxLength: 1000,
                        decoration: const InputDecoration(
                          labelText: 'Escribe tu pregunta',
                          counterText: '',
                        ),
                      ),
                    ),
                    IconButton.filled(
                      tooltip: 'Enviar',
                      onPressed: _busy ? null : _send,
                      icon: const Icon(Icons.send),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
