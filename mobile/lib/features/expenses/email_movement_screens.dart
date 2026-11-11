import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/design.dart';
import '../../core/format.dart';
import '../../core/widgets.dart';
import 'finance.dart';
import 'movement_fields.dart';

String emailDetailsLabel(Movement item) =>
    item.income ? 'Editar nota' : 'Editar categoría y nota';

class EmailMovementDetailsForm extends ConsumerStatefulWidget {
  const EmailMovementDetailsForm(this.item, this.details, {super.key});

  final Movement item;
  final EmailMovementDetails details;

  @override
  ConsumerState<EmailMovementDetailsForm> createState() =>
      _EmailMovementDetailsFormState();
}

class _EmailMovementDetailsFormState
    extends ConsumerState<EmailMovementDetailsForm> {
  final _form = GlobalKey<FormState>();
  late final _note = TextEditingController(text: widget.details.note ?? '');
  late String? _category = widget.item.category;
  bool _busy = false;
  String? _error;

  String get _noteText => _note.text.trim();
  bool get _noteChanged => _noteText != (widget.details.note ?? '');
  bool get _categoryChanged =>
      !widget.item.income &&
      _category != null &&
      _category != widget.item.category;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy || !_form.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(financeRepositoryProvider)
          .editEmailDetails(widget.item.id, {
            if (_categoryChanged) 'category': _category,
            if (_noteChanged) 'note': _noteText.isEmpty ? null : _noteText,
          });
      if (!mounted) return;
      context.pop();
      refreshFinance(ref);
    } catch (error) {
      if (mounted) setState(() => _error = failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => _EmailForm(
    title: emailDetailsLabel(widget.item),
    form: _form,
    busy: _busy,
    error: _error,
    onSave: _noteChanged || _categoryChanged ? _save : null,
    fields: [
      if (!widget.item.income) ...[
        ExpenseCategoryField(
          category: _category,
          requiredSelection: false,
          onChanged: _busy
              ? null
              : (value) => setState(() => _category = value),
        ),
        const SizedBox(height: 12),
      ],
      LabeledField(
        'Nota opcional',
        child: TextFormField(
          key: const ValueKey('movement-note'),
          controller: _note,
          enabled: !_busy,
          minLines: 2,
          maxLines: 5,
          maxLength: 200,
          onChanged: (_) => setState(() {}),
          validator: (value) => (value?.trim().runes.length ?? 0) > 200
              ? 'Escribe una nota de hasta 200 caracteres.'
              : null,
        ),
      ),
    ],
  );
}

class EmailMovementCorrectionForm extends ConsumerStatefulWidget {
  const EmailMovementCorrectionForm(this.item, this.details, {super.key});

  final Movement item;
  final EmailMovementDetails details;

  @override
  ConsumerState<EmailMovementCorrectionForm> createState() =>
      _EmailMovementCorrectionFormState();
}

class _EmailMovementCorrectionFormState
    extends ConsumerState<EmailMovementCorrectionForm> {
  final _form = GlobalKey<FormState>();
  late final _amount = TextEditingController(
    text: _amountText(widget.item.minor),
  );
  late String _date = widget.item.date;
  bool _busy = false;
  bool _conflict = false;
  String? _error;

  String _amountText(BigInt minor) => money(minor, '').trim();

  BigInt? get _minor {
    final text = _amount.text.trim();
    if (text == _amountText(widget.item.minor)) return widget.item.minor;
    if (text == _amountText(widget.details.originalMinor)) {
      return widget.details.originalMinor;
    }
    return parseMinor(text);
  }

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy || _conflict || !_form.currentState!.validate()) return;
    final item = widget.item;
    final details = widget.details;
    final minor = _minor!;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(financeRepositoryProvider).correct(item.id, {
        'revision': details.revision,
        if (minor != item.minor)
          'amountMinor': minor == details.originalMinor
              ? null
              : minor.toString(),
        if (_date != item.date)
          'date': _date == details.originalDate ? null : _date,
      });
      if (!mounted) return;
      context.pop();
      refreshFinance(ref);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = failureMessage(error);
        _conflict = error is ApiFailure && error.status == 409;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _reload() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final provider = movementProvider(widget.item.id);
      ref.invalidate(provider);
      await ref.read(provider.future);
    } catch (error) {
      if (mounted) setState(() => _error = failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final details = widget.details;
    final minor = _minor;
    return _EmailForm(
      title: 'Corregir datos',
      form: _form,
      busy: _busy,
      error: _error,
      onReload: _conflict ? _reload : null,
      onSave: !_conflict && (minor != item.minor || _date != item.date)
          ? _save
          : null,
      fields: [
        LabeledField(
          'Monto',
          child: TextFormField(
            key: const ValueKey('movement-amount'),
            controller: _amount,
            enabled: !_busy,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(suffixText: item.currency),
            onChanged: (_) => setState(() {}),
            validator: (_) =>
                _minor == null ? 'Ingresa un monto positivo válido.' : null,
          ),
        ),
        _OriginalValue(
          label: 'Monto original',
          value: money(details.originalMinor, item.currency),
          onRestore: _busy || minor == details.originalMinor
              ? null
              : () => setState(
                  () => _amount.text = _amountText(details.originalMinor),
                ),
        ),
        const SizedBox(height: 12),
        MovementDateField(
          date: _date,
          onChanged: _busy ? null : (value) => setState(() => _date = value),
        ),
        _OriginalValue(
          label: 'Fecha original',
          value: shortDay(details.originalDate),
          onRestore: _busy || _date == details.originalDate
              ? null
              : () => setState(() => _date = details.originalDate),
        ),
      ],
    );
  }
}

class _EmailForm extends StatelessWidget {
  const _EmailForm({
    required this.title,
    required this.form,
    required this.fields,
    required this.busy,
    this.error,
    this.onSave,
    this.onReload,
  });

  final String title;
  final GlobalKey<FormState> form;
  final List<Widget> fields;
  final bool busy;
  final String? error;
  final VoidCallback? onSave, onReload;

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !busy,
    child: Scaffold(
      appBar: appBackBar('Movimientos', () {
        if (!busy) context.pop();
      }),
      body: Form(
        key: form,
        child: ListView(
          padding: screenPadding,
          children: [
            PageHeading(title),
            const SizedBox(height: 16),
            ...fields,
            if (error case final message?) ...[
              const SizedBox(height: 12),
              AppNotice(
                icon: Icons.error_outline,
                title: message,
                tone: AppTone.danger,
              ),
            ],
            const SizedBox(height: 16),
            if (onReload != null)
              OutlinedButton(
                onPressed: busy ? null : onReload,
                child: Text(busy ? 'Cargando…' : 'Recargar datos'),
              )
            else
              FilledButton.icon(
                onPressed: busy ? null : onSave,
                icon: const Icon(Icons.check_rounded),
                label: Text(busy ? 'Guardando…' : 'Guardar cambios'),
              ),
          ],
        ),
      ),
    ),
  );
}

class _OriginalValue extends StatelessWidget {
  const _OriginalValue({
    required this.label,
    required this.value,
    this.onRestore,
  });

  final String label, value;
  final VoidCallback? onRestore;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: Text(
          '$label: $value',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ),
      TextButton(
        onPressed: onRestore,
        child: Text(
          'Usar original',
          semanticsLabel: 'Usar ${label.toLowerCase()}',
        ),
      ),
    ],
  );
}

class EmailCorrectionHistoryScreen extends ConsumerStatefulWidget {
  const EmailCorrectionHistoryScreen(this.item, {super.key});

  final Movement item;

  @override
  ConsumerState<EmailCorrectionHistoryScreen> createState() =>
      _EmailCorrectionHistoryScreenState();
}

class _EmailCorrectionHistoryScreenState
    extends ConsumerState<EmailCorrectionHistoryScreen> {
  final _items = <MovementCorrection>[];
  int? _beforeRevision;
  bool _busy = false;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final page = await ref
          .read(financeRepositoryProvider)
          .corrections(widget.item.id, beforeRevision: _beforeRevision);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _beforeRevision = page.nextBeforeRevision;
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    return Scaffold(
      appBar: appBackBar('Movimientos', () => context.pop()),
      body: ListView(
        padding: screenPadding,
        children: [
          PageHeading('Historial de correcciones', description: item.title),
          const SizedBox(height: 14),
          for (final entry in _items) ...[
            DetailFields([
              ('Fecha y hora', syncLabel(entry.correctedAt)),
              if (entry.previousMinor != entry.minor) ...[
                ('Monto anterior', money(entry.previousMinor, item.currency)),
                ('Monto nuevo', money(entry.minor, item.currency)),
              ],
              if (entry.previousDate != entry.date) ...[
                ('Fecha anterior', shortDay(entry.previousDate)),
                ('Fecha nueva', shortDay(entry.date)),
              ],
            ]),
            const SizedBox(height: 10),
          ],
          if (_busy)
            const Center(
              child: CircularProgressIndicator(
                semanticsLabel: 'Cargando correcciones',
              ),
            )
          else if (_error case final error?)
            RetryMessage(error, _load)
          else if (_beforeRevision != null)
            OutlinedButton(
              onPressed: _load,
              child: const Text('Cargar anteriores'),
            )
          else if (_items.isEmpty)
            const Text('Aún no hay correcciones.'),
        ],
      ),
    );
  }
}
