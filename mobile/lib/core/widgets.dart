import 'package:flutter/material.dart';

import 'api.dart';
import 'design.dart';
import 'format.dart';

AppBar brandBar() => AppBar(title: const BrandLockup());

AppBar appBackBar(String label, VoidCallback onBack) => AppBar(
  leadingWidth: 48,
  titleSpacing: 2,
  leading: BackButton(onPressed: onBack),
  title: Text(label),
);

class BrandMark extends StatelessWidget {
  const BrandMark(this.size, {super.key});
  final double size;

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: size,
    child: OverflowBox(
      maxWidth: size * 1.39,
      maxHeight: size * 1.39,
      child: Image.asset('assets/brand.png', excludeFromSemantics: true),
    ),
  );
}

class BrandLockup extends StatelessWidget {
  const BrandLockup({super.key, this.hero = false});
  final bool hero;

  @override
  Widget build(BuildContext context) {
    final name = Text.rich(
      const TextSpan(
        text: 'MailGasto ',
        children: [
          TextSpan(
            text: 'IA',
            style: TextStyle(color: AppColors.income),
          ),
        ],
      ),
      textAlign: hero ? TextAlign.center : TextAlign.start,
      style: TextStyle(
        fontSize: hero ? 24 : 15,
        fontWeight: FontWeight.w800,
        letterSpacing: hero ? -0.45 : -0.15,
        color: AppColors.ink,
      ),
    );
    return hero
        ? Column(
            mainAxisSize: MainAxisSize.min,
            children: [const BrandMark(74), const SizedBox(height: 7), name],
          )
        : Row(
            children: [
              const BrandMark(24),
              const SizedBox(width: 8),
              Flexible(child: name),
            ],
          );
  }
}

class PageHeading extends StatelessWidget {
  const PageHeading(this.title, {super.key, this.eyebrow, this.description});
  final String title;
  final String? eyebrow, description;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (eyebrow case final label?) ...[
          Text(
            label,
            style: text.labelSmall?.copyWith(
              color: AppColors.primary,
              letterSpacing: 1.45,
            ),
          ),
          const SizedBox(height: 6),
        ],
        Semantics(header: true, child: Text(title, style: text.headlineMedium)),
        if (description case final subtitle?) ...[
          const SizedBox(height: 6),
          Text(
            subtitle,
            style: text.bodyMedium?.copyWith(color: AppColors.muted),
          ),
        ],
      ],
    );
  }
}

class SectionHeading extends StatelessWidget {
  const SectionHeading(
    this.title, {
    super.key,
    this.action,
    this.compact = false,
  });
  final String title;
  final Widget? action;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final heading = Semantics(
      header: true,
      child: Text(title, style: compact ? text.titleMedium : text.titleLarge),
    );
    if (action == null) return heading;
    return TrailingRow(leading: heading, trailing: action!);
  }
}

class TrailingRow extends StatelessWidget {
  const TrailingRow({
    super.key,
    required this.leading,
    required this.trailing,
    this.maxFraction = .43,
    this.crossAxisAlignment = CrossAxisAlignment.center,
  });
  final Widget leading, trailing;
  final double maxFraction;
  final CrossAxisAlignment crossAxisAlignment;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => Row(
      crossAxisAlignment: crossAxisAlignment,
      children: [
        Expanded(child: leading),
        const SizedBox(width: 8),
        ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: constraints.maxWidth * maxFraction,
          ),
          child: trailing,
        ),
      ],
    ),
  );
}

class IconTile extends StatelessWidget {
  const IconTile(
    this.icon, {
    super.key,
    this.tone = AppTone.info,
    this.size = 40,
  });
  final IconData icon;
  final AppTone tone;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: tone.tint,
      borderRadius: BorderRadius.circular(size * .3),
    ),
    alignment: Alignment.center,
    child: Icon(icon, size: size * .49, color: tone.ink),
  );
}

class AppBadge extends StatelessWidget {
  const AppBadge(this.label, {super.key, this.tone = AppTone.info, this.icon});
  final String label;
  final AppTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      color: tone.tint,
      borderRadius: BorderRadius.circular(24),
    ),
    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (icon case final symbol?) ...[
          Icon(symbol, color: tone.ink, size: 13),
          const SizedBox(width: 5),
        ],
        Flexible(
          child: Text(
            label,
            style: Theme.of(
              context,
            ).textTheme.labelSmall?.copyWith(color: tone.ink),
          ),
        ),
      ],
    ),
  );
}

class AppNotice extends StatelessWidget {
  const AppNotice({
    super.key,
    required this.icon,
    required this.title,
    this.description,
    this.tone = AppTone.info,
    this.onTap,
    this.compact = false,
  });
  final IconData icon;
  final String title;
  final String? description;
  final AppTone tone;
  final VoidCallback? onTap;
  final bool compact;

  @override
  Widget build(BuildContext context) => Material(
    color: tone.tint,
    borderRadius: BorderRadius.circular(16),
    clipBehavior: Clip.antiAlias,
    child: InkWell(
      onTap: onTap,
      child: Padding(
        padding: compact
            ? const EdgeInsets.symmetric(horizontal: 13, vertical: 9)
            : const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 19, color: tone.ink),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: Theme.of(
                      context,
                    ).textTheme.titleMedium?.copyWith(color: tone.ink),
                  ),
                  if (description case final body?) ...[
                    const SizedBox(height: 3),
                    Text(
                      body,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: tone.ink,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (onTap != null)
              Icon(Icons.chevron_right, size: 19, color: tone.ink),
          ],
        ),
      ),
    ),
  );
}

class AppPanel extends StatelessWidget {
  const AppPanel({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(14),
  });
  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(padding: padding, child: child),
  );
}

class LabeledField extends StatelessWidget {
  const LabeledField(this.label, {super.key, required this.child});
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      ExcludeSemantics(
        child: Text(label, style: Theme.of(context).textTheme.labelMedium),
      ),
      const SizedBox(height: 5),
      Semantics(label: label, child: child),
    ],
  );
}

class PasswordField extends StatefulWidget {
  const PasswordField({
    super.key,
    required this.fieldKey,
    required this.label,
    required this.controller,
    required this.validator,
    this.autofillHints,
    this.enabled = true,
    this.onSubmitted,
  });

  final Key fieldKey;
  final String label;
  final TextEditingController controller;
  final FormFieldValidator<String> validator;
  final Iterable<String>? autofillHints;
  final bool enabled;
  final ValueChanged<String>? onSubmitted;

  @override
  State<PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<PasswordField> {
  bool _visible = false;

  @override
  Widget build(BuildContext context) => LabeledField(
    widget.label,
    child: TextFormField(
      key: widget.fieldKey,
      controller: widget.controller,
      enabled: widget.enabled,
      obscureText: !_visible,
      autofillHints: widget.autofillHints,
      onFieldSubmitted: widget.onSubmitted,
      decoration: InputDecoration(
        suffixIcon: IconButton(
          tooltip: _visible ? 'Ocultar contraseña' : 'Mostrar contraseña',
          onPressed: widget.enabled
              ? () => setState(() => _visible = !_visible)
              : null,
          icon: Icon(
            _visible
                ? Icons.visibility_off_outlined
                : Icons.visibility_outlined,
            size: 19,
          ),
        ),
      ),
      validator: widget.validator,
    ),
  );
}

class FormPair extends StatelessWidget {
  const FormPair({
    super.key,
    required this.first,
    required this.second,
    this.firstFlex = 1,
    this.secondFlex = 1,
  });
  final Widget first, second;
  final int firstFlex, secondFlex;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      if (constraints.maxWidth < 290 ||
          MediaQuery.textScalerOf(context).scale(14) > 18) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [first, const SizedBox(height: 12), second],
        );
      }
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(flex: firstFlex, child: first),
          const SizedBox(width: 12),
          Expanded(flex: secondFlex, child: second),
        ],
      );
    },
  );
}

class FilterLabel extends StatelessWidget {
  const FilterLabel(
    this.label, {
    super.key,
    this.icon,
    this.highlighted = false,
  });
  final String label;
  final IconData? icon;
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    final color = highlighted ? AppColors.accent : AppColors.muted;
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 44),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 7),
            decoration: BoxDecoration(
              color: highlighted ? AppColors.blueTint : AppColors.surface,
              borderRadius: BorderRadius.circular(11),
              border: highlighted ? null : Border.all(color: AppColors.border),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon case final symbol?) ...[
                  Icon(symbol, color: color, size: 14),
                  const SizedBox(width: 5),
                ],
                Flexible(
                  child: Text(
                    label,
                    style: Theme.of(
                      context,
                    ).textTheme.labelMedium?.copyWith(color: color),
                  ),
                ),
                const SizedBox(width: 3),
                Icon(Icons.keyboard_arrow_down_rounded, color: color, size: 14),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class SegmentTabs<T> extends StatelessWidget {
  const SegmentTabs({
    super.key,
    required this.items,
    required this.selected,
    required this.onSelect,
  });
  final Map<T, String> items;
  final T? selected;
  final ValueChanged<T>? onSelect;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final scale = MediaQuery.textScalerOf(context).scale(12);
      final columns = items.length > 2 && constraints.maxWidth < scale * 25
          ? 2
          : items.length;
      final width = (constraints.maxWidth - 8 - (columns - 1) * 3) / columns;
      return Container(
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
          color: AppColors.neutralTint,
          borderRadius: BorderRadius.circular(13),
        ),
        child: Wrap(
          spacing: 3,
          runSpacing: 3,
          children: [
            for (final entry in items.entries)
              SizedBox(
                width: width,
                child: Semantics(
                  button: true,
                  selected: selected == entry.key,
                  inMutuallyExclusiveGroup: true,
                  child: Material(
                    color: selected == entry.key
                        ? AppColors.surface
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(10),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(10),
                      onTap: onSelect == null
                          ? null
                          : () => onSelect!(entry.key),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(minHeight: 40),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 3,
                            vertical: 6,
                          ),
                          child: Center(
                            child: Text(
                              entry.value,
                              textAlign: TextAlign.center,
                              style: Theme.of(context).textTheme.labelMedium
                                  ?.copyWith(
                                    color: selected == entry.key
                                        ? AppColors.accent
                                        : AppColors.muted,
                                    fontWeight: selected == entry.key
                                        ? FontWeight.w800
                                        : FontWeight.w600,
                                  ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      );
    },
  );
}

class DetailFields extends StatelessWidget {
  const DetailFields(this.fields, {super.key});
  final List<(String, String)> fields;

  @override
  Widget build(BuildContext context) => AppPanel(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (index, (label, value)) in fields.indexed) ...[
          if (index > 0) const Divider(height: 17),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  label,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                flex: 2,
                child: Text(
                  value,
                  textAlign: TextAlign.end,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
            ],
          ),
        ],
      ],
    ),
  );
}

ButtonStyle dangerButtonStyle() => FilledButton.styleFrom(
  foregroundColor: AppColors.danger,
  backgroundColor: AppColors.dangerTint,
);

class FormLayout extends StatelessWidget {
  const FormLayout({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => SafeArea(
    top: false,
    child: SingleChildScrollView(
      padding: screenPadding,
      child: Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: child,
        ),
      ),
    ),
  );
}

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
  Widget build(BuildContext context) => AppBadge(
    noticeStatuses[status] ?? 'Estado desconocido',
    tone: switch (status) {
      'pending' => AppTone.warning,
      'error' => AppTone.danger,
      'registered' => AppTone.income,
      _ => AppTone.info,
    },
  );
}

void showMessage(BuildContext context, String message) {
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}
