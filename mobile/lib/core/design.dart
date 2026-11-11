import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

abstract final class AppColors {
  static const canvas = Color(0xFFF5F7FF);
  static const surface = Colors.white;
  static const ink = Color(0xFF111A40);
  static const muted = Color(0xFF556380);
  static const border = Color(0xFFDCE3F3);
  static const primary = Color(0xFF2945DB);
  static const accent = Color(0xFF2338B7);
  static const blueTint = Color(0xFFEBEFFE);
  static const neutralTint = Color(0xFFEBEFF7);
  static const income = Color(0xFF08785B);
  static const incomeTint = Color(0xFFE4F6EF);
  static const expense = Color(0xFF5140C1);
  static const expenseTint = Color(0xFFF0ECFF);
  static const warning = Color(0xFF874805);
  static const warningTint = Color(0xFFFFF1D8);
  static const danger = Color(0xFFB42318);
  static const dangerTint = Color(0xFFFCEDEA);
}

enum AppTone {
  info(AppColors.accent, AppColors.blueTint),
  neutral(AppColors.muted, AppColors.neutralTint),
  income(AppColors.income, AppColors.incomeTint),
  expense(AppColors.expense, AppColors.expenseTint),
  warning(AppColors.warning, AppColors.warningTint),
  danger(AppColors.danger, AppColors.dangerTint);

  const AppTone(this.ink, this.tint);
  final Color ink;
  final Color tint;
}

const screenPadding = EdgeInsets.fromLTRB(20, 8, 20, 20);
const tabularFigures = [FontFeature.tabularFigures()];

ThemeData mailGastoTheme() {
  const fieldBorder = OutlineInputBorder(
    borderRadius: BorderRadius.all(Radius.circular(13)),
    borderSide: BorderSide(color: AppColors.border),
  );
  const buttonShape = RoundedRectangleBorder(
    borderRadius: BorderRadius.all(Radius.circular(13)),
  );
  const buttonText = TextStyle(fontSize: 14, fontWeight: FontWeight.w700);
  const buttonPadding = EdgeInsets.symmetric(horizontal: 16, vertical: 12);
  const buttonSize = Size(0, 48);
  final colors = ColorScheme.fromSeed(seedColor: AppColors.primary).copyWith(
    primary: AppColors.primary,
    onPrimary: AppColors.surface,
    primaryContainer: AppColors.blueTint,
    onPrimaryContainer: AppColors.accent,
    secondaryContainer: AppColors.blueTint,
    onSecondaryContainer: AppColors.accent,
    surface: AppColors.surface,
    surfaceContainerHighest: AppColors.neutralTint,
    onSurface: AppColors.ink,
    onSurfaceVariant: AppColors.muted,
    outline: AppColors.border,
    outlineVariant: AppColors.border,
    error: AppColors.danger,
    errorContainer: AppColors.dangerTint,
    onErrorContainer: AppColors.danger,
  );
  final base = ThemeData(useMaterial3: true, colorScheme: colors);
  return base.copyWith(
    scaffoldBackgroundColor: AppColors.canvas,
    textTheme: base.textTheme.copyWith(
      headlineMedium: const TextStyle(
        fontSize: 30,
        height: 1.12,
        fontWeight: FontWeight.w800,
        letterSpacing: -0.65,
        color: AppColors.ink,
      ),
      headlineSmall: const TextStyle(
        fontSize: 24,
        height: 1.18,
        fontWeight: FontWeight.w800,
        letterSpacing: -0.35,
        color: AppColors.ink,
      ),
      titleLarge: const TextStyle(
        fontSize: 18,
        height: 1.23,
        fontWeight: FontWeight.w800,
        color: AppColors.ink,
      ),
      titleMedium: const TextStyle(
        fontSize: 15,
        height: 1.26,
        fontWeight: FontWeight.w700,
        color: AppColors.ink,
      ),
      bodyLarge: const TextStyle(
        fontSize: 15,
        height: 1.35,
        color: AppColors.ink,
      ),
      bodyMedium: const TextStyle(
        fontSize: 14,
        height: 1.38,
        color: AppColors.ink,
      ),
      bodySmall: const TextStyle(
        fontSize: 12,
        height: 1.35,
        color: AppColors.muted,
      ),
      labelLarge: buttonText,
      labelMedium: const TextStyle(
        fontSize: 12,
        height: 1.25,
        fontWeight: FontWeight.w700,
        color: AppColors.muted,
      ),
      labelSmall: const TextStyle(
        fontSize: 11,
        height: 1.22,
        fontWeight: FontWeight.w700,
        color: AppColors.muted,
      ),
    ),
    appBarTheme: const AppBarThemeData(
      backgroundColor: AppColors.canvas,
      foregroundColor: AppColors.ink,
      surfaceTintColor: Colors.transparent,
      scrolledUnderElevation: 0,
      toolbarHeight: 48,
      centerTitle: false,
      titleSpacing: 20,
      titleTextStyle: TextStyle(
        fontSize: 15,
        fontWeight: FontWeight.w700,
        color: AppColors.ink,
      ),
      systemOverlayStyle: SystemUiOverlayStyle.dark,
    ),
    cardTheme: const CardThemeData(
      color: AppColors.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(18)),
        side: BorderSide(color: AppColors.border),
      ),
    ),
    dividerTheme: const DividerThemeData(color: AppColors.border, thickness: 1),
    inputDecorationTheme: const InputDecorationTheme(
      filled: true,
      fillColor: AppColors.surface,
      isDense: true,
      constraints: BoxConstraints(minHeight: 48),
      contentPadding: EdgeInsets.symmetric(horizontal: 13, vertical: 13),
      border: fieldBorder,
      enabledBorder: fieldBorder,
      disabledBorder: fieldBorder,
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.all(Radius.circular(13)),
        borderSide: BorderSide(color: AppColors.primary, width: 1.5),
      ),
      hintStyle: TextStyle(color: AppColors.muted, fontSize: 13),
      suffixIconColor: AppColors.muted,
      errorMaxLines: 3,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: buttonSize,
        padding: buttonPadding,
        shape: buttonShape,
        textStyle: buttonText,
        iconSize: 18,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: buttonSize,
        padding: buttonPadding,
        backgroundColor: AppColors.surface,
        side: const BorderSide(color: Color(0xFFCDD6FF)),
        shape: buttonShape,
        textStyle: buttonText,
        iconSize: 18,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(textStyle: buttonText, iconSize: 17),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: AppColors.surface,
      surfaceTintColor: Colors.transparent,
      indicatorColor: AppColors.blueTint,
      indicatorShape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(13),
      ),
      elevation: 0,
      height: 62,
      iconTheme: WidgetStateProperty.resolveWith(
        (states) => IconThemeData(
          size: 21,
          color: states.contains(WidgetState.selected)
              ? AppColors.primary
              : AppColors.muted,
        ),
      ),
      labelTextStyle: WidgetStateProperty.resolveWith(
        (states) => TextStyle(
          fontSize: 10.5,
          height: 1.15,
          fontWeight: states.contains(WidgetState.selected)
              ? FontWeight.w800
              : FontWeight.w600,
          color: states.contains(WidgetState.selected)
              ? AppColors.accent
              : AppColors.muted,
        ),
      ),
    ),
    dialogTheme: const DialogThemeData(
      backgroundColor: AppColors.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(20)),
      ),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: AppColors.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: AppColors.ink,
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(12)),
      ),
    ),
  );
}
