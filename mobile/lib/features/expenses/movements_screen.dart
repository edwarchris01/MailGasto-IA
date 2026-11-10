import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/widgets.dart';
import 'expenses.dart';
import 'finance.dart';
import 'finance_screens.dart';

class MovementsScreen extends ConsumerWidget {
  const MovementsScreen(this.query, {super.key});
  final Map<String, String> query;

  void _navigate(BuildContext context, Map<String, String?> changes) =>
      context.go(
        financePath('/history', {
          for (final entry in {...query, ...changes}.entries)
            if (entry.value != null) entry.key: entry.value!,
        }),
      );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    const tabs = {
      'all': 'Todos',
      'income': 'Ingresos',
      'expense': 'Gastos',
      'notices': 'Avisos',
    };
    final tab = tabs.containsKey(query['tab']) ? query['tab']! : 'all';
    final notices = tab == 'notices';
    final defaults = currentRange();
    final from = query['from'] ?? defaults.from;
    final to = query['to'] ?? defaults.to;
    final currency = query['currency'] == 'all'
        ? null
        : query['currency'] ?? 'COP';
    final period = (from: from, to: to, currency: currency ?? 'COP');
    final movementFilter = (
      from: from,
      to: to,
      currency: currency,
      category: query['category'],
      source: query['source'],
      direction: tab == 'income' || tab == 'expense' ? tab : null,
    );
    final reports = movementsProvider(movementFilter);
    final noticeList = historyProvider((
      from: from,
      to: to,
      category: null,
      status: query['status'],
    ));

    return Scaffold(
      appBar: AppBar(title: const Text('Movimientos')),
      body: RefreshIndicator(
        onRefresh: () async {
          try {
            await (notices
                ? ref.refresh(noticeList.future).then<void>((_) {})
                : ref.refresh(reports.future).then<void>((_) {}));
          } catch (_) {
            // El estado del proveedor presenta el error y permite reintentar.
          }
        },
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              sliver: SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      spacing: 7,
                      children: [
                        for (final entry in tabs.entries)
                          ChoiceChip(
                            label: Text(entry.value),
                            selected: tab == entry.key,
                            onSelected: (_) => _navigate(context, {
                              'tab': entry.key,
                              'category': null,
                              'status': null,
                              'source': null,
                            }),
                          ),
                      ],
                    ),
                    RangeControls(
                      range: period,
                      showCurrency: false,
                      onChange: (value) => _navigate(context, {
                        'from': value.from,
                        'to': value.to,
                      }),
                    ),
                    Wrap(
                      spacing: 14,
                      runSpacing: 4,
                      children: [
                        if (notices)
                          _Filter(
                            'Estado',
                            query['status'],
                            const {
                              'processing': 'En proceso',
                              'pending': 'Pendiente',
                              'error': 'Error',
                            },
                            (value) => _navigate(context, {'status': value}),
                          )
                        else ...[
                          _Filter(
                            'Moneda',
                            currency,
                            currencies,
                            (value) => _navigate(context, {
                              'currency': value ?? 'all',
                            }),
                          ),
                          if (tab != 'income')
                            _Filter(
                              'Categoría',
                              query['category'],
                              categories,
                              (value) =>
                                  _navigate(context, {'category': value}),
                            ),
                          _Filter(
                            'Origen',
                            query['source'],
                            movementSources,
                            (value) => _navigate(context, {'source': value}),
                          ),
                        ],
                      ],
                    ),
                    if (!notices)
                      FilledButton.icon(
                        icon: const Icon(Icons.add),
                        label: const Text('Registrar movimiento'),
                        onPressed: () => context.push(
                          financePath('/history/new', {
                            'currency': currency ?? 'COP',
                            'direction': ?movementFilter.direction,
                          }),
                        ),
                      ),
                    const SizedBox(height: 12),
                  ],
                ),
              ),
            ),
            if (notices)
              ref
                  .watch(noticeList)
                  .when(
                    loading: _progress,
                    error: (error, _) =>
                        _retry(error, () => ref.invalidate(noticeList)),
                    data: (page) => _rows(
                      context,
                      page.items.length,
                      page.hasMore,
                      'No hay avisos que coincidan con los filtros.',
                      () => ref.read(noticeList.notifier).loadMore(),
                      (index) {
                        final notice = page.items[index];
                        return Card(
                          child: ListTile(
                            leading: const Icon(Icons.mail_outline),
                            title: Text(notice.providerLabel),
                            subtitle: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(syncLabel(notice.receivedAt)),
                                StatusBadge(notice.status),
                              ],
                            ),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => context.push(
                              financePath('/history/${notice.id}', {
                                ...query,
                                'tab': 'notices',
                              }),
                            ),
                          ),
                        );
                      },
                    ),
                  )
            else
              ref
                  .watch(reports)
                  .when(
                    loading: _progress,
                    error: (error, _) =>
                        _retry(error, () => ref.invalidate(reports)),
                    data: (page) => _rows(
                      context,
                      page.items.length,
                      page.hasMore,
                      'No hay movimientos que coincidan con los filtros.',
                      () => ref.read(reports.notifier).more(),
                      (index) {
                        final item = page.items[index];
                        return Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (index == 0 ||
                                page.items[index - 1].date != item.date)
                              Padding(
                                padding: const EdgeInsets.fromLTRB(4, 10, 4, 4),
                                child: Text(
                                  dayLabel(item.date),
                                  style: Theme.of(context).textTheme.labelLarge,
                                ),
                              ),
                            MovementTile(
                              item,
                              onTap: () =>
                                  context.push('/history/movement/${item.id}'),
                            ),
                          ],
                        );
                      },
                    ),
                  ),
          ],
        ),
      ),
    );
  }

  Widget _progress() => const SliverToBoxAdapter(
    child: LinearProgressIndicator(semanticsLabel: 'Cargando movimientos'),
  );

  Widget _retry(Object error, VoidCallback retry) =>
      SliverToBoxAdapter(child: RetryMessage(error, retry));

  Widget _rows(
    BuildContext context,
    int count,
    bool more,
    String empty,
    Future<void> Function() next,
    Widget Function(int) row,
  ) {
    if (count == 0) {
      return SliverToBoxAdapter(
        child: Padding(padding: const EdgeInsets.all(20), child: Text(empty)),
      );
    }
    return SliverPadding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
      sliver: SliverList.builder(
        itemCount: count + (more ? 1 : 0),
        itemBuilder: (context, index) => index < count
            ? row(index)
            : TextButton(
                onPressed: () async {
                  try {
                    await next();
                  } catch (error) {
                    if (context.mounted) {
                      showMessage(context, failureMessage(error));
                    }
                  }
                },
                child: const Text('Cargar más'),
              ),
      ),
    );
  }
}

class _Filter extends StatelessWidget {
  const _Filter(this.label, this.value, this.options, this.onChange);
  final String label;
  final String? value;
  final Map<String, String> options;
  final ValueChanged<String?> onChange;

  @override
  Widget build(BuildContext context) => PopupMenuButton<String>(
    tooltip: label,
    child: Chip(
      label: Text(options[value] ?? label),
      avatar: const Icon(Icons.expand_more, size: 17),
    ),
    onSelected: (value) => onChange(value.isEmpty ? null : value),
    itemBuilder: (_) => [
      const PopupMenuItem(value: '', child: Text('Todos')),
      for (final entry in options.entries)
        PopupMenuItem(value: entry.key, child: Text(entry.value)),
    ],
  );
}

class MovementScreen extends ConsumerWidget {
  const MovementScreen(this.id, {super.key, this.editing = false});
  final String id;
  final bool editing;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = movementProvider(id);
    return ref
        .watch(provider)
        .when(
          loading: () => Scaffold(
            appBar: AppBar(title: const Text('Detalle')),
            body: const Center(child: CircularProgressIndicator()),
          ),
          error: (error, _) => Scaffold(
            appBar: AppBar(title: const Text('Detalle')),
            body: RetryMessage(error, () => ref.invalidate(provider)),
          ),
          data: (item) => editing && item.manual
              ? MovementForm(existing: item)
              : _MovementDetail(item),
        );
  }
}

class _MovementDetail extends ConsumerStatefulWidget {
  const _MovementDetail(this.item);
  final Movement item;

  @override
  ConsumerState<_MovementDetail> createState() => _MovementDetailState();
}

class _MovementDetailState extends ConsumerState<_MovementDetail> {
  bool _busy = false;

  Future<void> _remove(Movement item) async {
    if (_busy) return;
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Eliminar movimiento manual'),
        content: Text(
          '«${item.title}» se eliminará del historial y se recalcularán los totales.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Eliminar'),
          ),
        ],
      ),
    );
    if (accepted != true || !mounted || _busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(financeRepositoryProvider).remove(item.id);
      if (!mounted) return;
      if (item.id == widget.item.id) context.pop();
      _refreshFinance(ref);
    } catch (error) {
      if (mounted) showMessage(context, failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final color = item.income ? incomeColor : expenseColor;
    return Scaffold(
      appBar: AppBar(title: const Text('Detalle del movimiento')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            color: item.income ? incomeSurface : expenseSurface,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.kind,
                    style: TextStyle(color: color, fontWeight: FontWeight.bold),
                  ),
                  Text(
                    item.signedAmount,
                    style: Theme.of(
                      context,
                    ).textTheme.headlineSmall?.copyWith(color: color),
                  ),
                  Text(item.title),
                ],
              ),
            ),
          ),
          for (final (label, value) in [
            ('Fecha', dayLabel(item.date)),
            ('Categoría', categories[item.category] ?? item.category),
            ('Medio de pago', item.method ?? 'Sin especificar'),
            ('Origen', movementSources[item.source] ?? item.source),
          ])
            ListTile(title: Text(label), subtitle: Text(value)),
          if (item.manual)
            Wrap(
              spacing: 12,
              children: [
                OutlinedButton.icon(
                  onPressed: _busy
                      ? null
                      : () => context.push('/history/movement/${item.id}/edit'),
                  icon: const Icon(Icons.edit_outlined),
                  label: const Text('Editar'),
                ),
                TextButton.icon(
                  onPressed: _busy ? null : () => _remove(item),
                  icon: const Icon(Icons.delete_outline),
                  label: const Text('Eliminar'),
                ),
              ],
            ),
          if (item.matches.isNotEmpty) ...[
            const SizedBox(height: 14),
            Text(
              'Posible duplicado',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const Text(
              'Compara los registros. Si corresponden al mismo movimiento, puedes eliminar el manual.',
            ),
            MovementTile(item),
            for (final match in item.matches) ...[
              MovementTile(
                match,
                onTap: () => context.push('/history/movement/${match.id}'),
              ),
              if (match.manual)
                TextButton(
                  onPressed: _busy ? null : () => _remove(match),
                  child: const Text('Eliminar manual'),
                ),
            ],
          ],
        ],
      ),
    );
  }
}

class MovementForm extends ConsumerStatefulWidget {
  const MovementForm({super.key, this.existing, this.direction, this.currency});
  final Movement? existing;
  final String? direction, currency;

  @override
  ConsumerState<MovementForm> createState() => _MovementFormState();
}

class _MovementFormState extends ConsumerState<MovementForm> {
  final _form = GlobalKey<FormState>();
  final _id = requestId();
  late final _amount = TextEditingController(
    text: widget.existing == null
        ? ''
        : money(widget.existing!.minor, '').trim(),
  );
  late final _method = TextEditingController(text: widget.existing?.method);
  late final _description = TextEditingController(
    text: widget.existing?.description,
  );
  late String _currency =
      widget.existing?.currency ??
      (currencies.containsKey(widget.currency) ? widget.currency! : 'COP');
  late String? _direction = widget.existing == null
      ? widget.direction
      : widget.existing!.income
      ? 'income'
      : 'expense';
  late String? _category = widget.existing?.income == false
      ? widget.existing?.category
      : null;
  late String _date = widget.existing?.date ?? isoDay(bogotaNow());
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    _method.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy || !_form.currentState!.validate()) return;
    if (_direction == null) {
      setState(() => _error = 'Elige si es un ingreso o un gasto.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final existing = widget.existing;
    final repository = ref.read(financeRepositoryProvider);
    final data = <String, dynamic>{
      'amountMinor': parseMinor(_amount.text)!.toString(),
      'currency': _currency,
      'direction': _direction,
      'date': _date,
      if (_direction == 'expense') 'category': _category,
      if (_method.text.trim().isNotEmpty) 'paymentMethod': _method.text.trim(),
      if (_description.text.trim().isNotEmpty)
        'description': _description.text.trim(),
    };
    try {
      if (existing == null) {
        await repository.create(data, _id);
      } else {
        await repository.edit(existing.id, data);
      }
      if (!mounted) return;
      if (existing == null) {
        context.go(
          financePath('/history', {
            'tab': _direction!,
            'currency': _currency,
            'from': _date,
            'to': _date,
          }),
        );
      } else {
        context.pop();
      }
      _refreshFinance(ref);
    } catch (error) {
      if (mounted) setState(() => _error = failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(
        widget.existing == null ? 'Registrar movimiento' : 'Editar movimiento',
      ),
    ),
    body: Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const Text('Tipo de movimiento'),
          Wrap(
            spacing: 8,
            children: [
              for (final (key, label) in [
                ('income', 'Ingreso'),
                ('expense', 'Gasto'),
              ])
                ChoiceChip(
                  label: Text(label),
                  selected: _direction == key,
                  onSelected: _busy
                      ? null
                      : (_) => setState(() {
                          _direction = key;
                          _error = null;
                        }),
                ),
            ],
          ),
          const SizedBox(height: 12),
          TextFormField(
            key: const ValueKey('movement-amount'),
            controller: _amount,
            enabled: !_busy,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(
              labelText: 'Monto',
              hintText: '42.000,00',
            ),
            validator: (value) => parseMinor(value ?? '') == null
                ? 'Ingresa un monto positivo válido.'
                : null,
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _currency,
            decoration: const InputDecoration(labelText: 'Moneda'),
            items: [
              for (final code in currencies.keys)
                DropdownMenuItem(value: code, child: Text(code)),
            ],
            onChanged: _busy
                ? null
                : (value) => setState(() => _currency = value!),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            icon: const Icon(Icons.calendar_month),
            label: Text('Fecha · ${dayLabel(_date)}'),
            onPressed: _busy
                ? null
                : () async {
                    final value = await showDatePicker(
                      context: context,
                      initialDate: DateTime.parse(_date),
                      firstDate: DateTime(1900),
                      lastDate: bogotaNow(),
                    );
                    if (mounted && value != null) {
                      setState(() => _date = isoDay(value));
                    }
                  },
          ),
          if (_direction == 'expense') ...[
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _category,
              decoration: const InputDecoration(labelText: 'Categoría'),
              items: [
                for (final entry in categories.entries)
                  if (entry.key != 'ingresos')
                    DropdownMenuItem(
                      value: entry.key,
                      child: Text(entry.value),
                    ),
              ],
              onChanged: _busy
                  ? null
                  : (value) => setState(() => _category = value),
              validator: (value) =>
                  value == null ? 'Selecciona una categoría.' : null,
            ),
          ],
          const SizedBox(height: 12),
          TextFormField(
            controller: _method,
            enabled: !_busy,
            maxLength: 60,
            decoration: const InputDecoration(
              labelText: 'Medio de pago (opcional)',
              counterText: '',
            ),
          ),
          const SizedBox(height: 12),
          TextFormField(
            key: const ValueKey('movement-description'),
            controller: _description,
            enabled: !_busy,
            maxLength: 200,
            decoration: const InputDecoration(
              labelText: 'Descripción (opcional)',
              counterText: '',
            ),
          ),
          const SizedBox(height: 12),
          const Text(
            'Origen manual · Aparecerá en el historial y en los totales.',
          ),
          if (_error case final error?)
            Text(
              error,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: _busy ? null : _save,
            icon: const Icon(Icons.check),
            label: Text(
              _busy
                  ? 'Guardando…'
                  : widget.existing != null
                  ? 'Guardar cambios'
                  : _direction == 'income'
                  ? 'Guardar ingreso'
                  : _direction == 'expense'
                  ? 'Guardar gasto'
                  : 'Guardar movimiento',
            ),
          ),
        ],
      ),
    ),
  );
}

void _refreshFinance(WidgetRef ref) {
  ref.invalidate(analyticsProvider);
  ref.invalidate(movementsProvider);
  ref.invalidate(movementProvider);
}

BigInt? parseMinor(String text) {
  var value = text.trim();
  if (RegExp(r'^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$').hasMatch(value)) {
    value = value.replaceAll('.', '');
  }
  if (!RegExp(r'^\d{1,16}(?:[,.]\d{1,2})?$').hasMatch(value)) return null;
  final parts = value.split(RegExp(r'[,.]'));
  final amount = BigInt.parse(
    parts.first + (parts.length > 1 ? parts.last.padRight(2, '0') : '00'),
  );
  return amount > BigInt.zero ? amount : null;
}
