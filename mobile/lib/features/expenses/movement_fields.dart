import 'package:flutter/material.dart';

import '../../core/design.dart';
import '../../core/format.dart';
import '../../core/widgets.dart';

class MovementDateField extends StatelessWidget {
  const MovementDateField({super.key, required this.date, this.onChanged});

  final String? date;
  final ValueChanged<String>? onChanged;

  Future<void> _pickDate(BuildContext context) async {
    final today = DateUtils.dateOnly(bogotaNow());
    final first = DateTime(1900);
    final selected = DateTime.tryParse(date ?? '') ?? today;
    final value = await showDatePicker(
      context: context,
      initialDate: selected.isBefore(first) || selected.isAfter(today)
          ? today
          : selected,
      firstDate: first,
      lastDate: today,
      currentDate: today,
    );
    if (context.mounted && value != null) onChanged?.call(isoDay(value));
  }

  @override
  Widget build(BuildContext context) => LabeledField(
    'Fecha',
    child: OutlinedButton(
      key: const ValueKey('movement-date'),
      onPressed: onChanged == null ? null : () => _pickDate(context),
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.ink,
        side: const BorderSide(color: AppColors.border),
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10),
        textStyle: Theme.of(context).textTheme.bodyLarge,
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(date == null ? 'Seleccionar fecha' : shortDay(date!)),
          ),
          const SizedBox(width: 6),
          const Icon(
            Icons.calendar_month_outlined,
            color: AppColors.muted,
            size: 18,
          ),
        ],
      ),
    ),
  );
}

class ExpenseCategoryField extends StatelessWidget {
  const ExpenseCategoryField({
    super.key,
    required this.category,
    this.onChanged,
    this.requiredSelection = true,
  });

  final String? category;
  final ValueChanged<String?>? onChanged;
  final bool requiredSelection;

  @override
  Widget build(BuildContext context) => LabeledField(
    'Categoría',
    child: DropdownButtonFormField<String>(
      key: const ValueKey('movement-category'),
      initialValue: category != 'ingresos' && categories.containsKey(category)
          ? category
          : null,
      decoration: const InputDecoration(),
      isExpanded: true,
      icon: const Icon(
        Icons.keyboard_arrow_down_rounded,
        size: 18,
        color: AppColors.muted,
      ),
      hint: const Text('Selecciona'),
      items: [
        for (final entry in categories.entries)
          if (entry.key != 'ingresos')
            DropdownMenuItem(value: entry.key, child: Text(entry.value)),
      ],
      onChanged: onChanged,
      validator: (value) => requiredSelection && value == null
          ? 'Selecciona una categoría.'
          : null,
    ),
  );
}
