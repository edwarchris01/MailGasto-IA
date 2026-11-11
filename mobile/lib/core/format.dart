import 'package:intl/intl.dart';
import 'package:timezone/timezone.dart' as tz;

DateTime bogotaNow() => tz.TZDateTime.now(tz.getLocation('America/Bogota'));

String isoDay(DateTime date) => DateFormat('yyyy-MM-dd').format(date);

String dayLabel(String value) =>
    DateFormat('dd/MM/yyyy', 'es_CO').format(DateTime.parse(value));

String shortDay(String value, {bool year = true}) {
  final date = DateTime.parse(value);
  final month = DateFormat('MMM', 'es_CO').format(date).replaceAll('.', '');
  return '${date.day} $month${year ? ' ${date.year}' : ''}';
}

String receivedDay(String value, {bool year = false}) => shortDay(
  isoDay(
    tz.TZDateTime.from(DateTime.parse(value), tz.getLocation('America/Bogota')),
  ),
  year: year,
);

String periodLabel(String from, String to) {
  if (from == to) return shortDay(from);
  final start = DateTime.parse(from);
  final end = DateTime.parse(to);
  if (start.year == end.year && start.month == end.month) {
    return '${start.day}–${shortDay(to)}';
  }
  return '${shortDay(from, year: start.year != end.year)} – ${shortDay(to)}';
}

String syncLabel(String value) =>
    DateFormat('dd/MM/yyyy HH:mm', 'es_CO').format(
      tz.TZDateTime.from(
        DateTime.parse(value),
        tz.getLocation('America/Bogota'),
      ),
    );

String money(BigInt minor, String currency) {
  final magnitude = minor.abs();
  final units = (magnitude ~/ BigInt.from(100)).toString().replaceAllMapped(
    RegExp(r'\B(?=(\d{3})+(?!\d))'),
    (_) => '.',
  );
  final cents = (magnitude % BigInt.from(100)).toString().padLeft(2, '0');
  return '${minor.isNegative ? '− ' : ''}$currency $units,$cents';
}

String displayMoney(BigInt minor, String currency, {bool symbol = true}) {
  final formatted = money(minor.abs(), currency).substring(currency.length + 1);
  final value = formatted.endsWith(',00')
      ? formatted.substring(0, formatted.length - 3)
      : formatted;
  final prefix = !symbol
      ? ''
      : switch (currency) {
          'COP' || 'USD' => r'$',
          'EUR' => '€',
          _ => '$currency ',
        };
  return '${minor.isNegative ? '− ' : ''}$prefix$value';
}

const categories = {
  'alimentacion': 'Alimentación',
  'transporte': 'Transporte',
  'vivienda': 'Vivienda',
  'ocio': 'Ocio',
  'salud': 'Salud',
  'educacion': 'Educación',
  'compras': 'Compras',
  'ingresos': 'Ingresos',
  'otros': 'Otros',
};

const noticeStatuses = {
  'processing': 'En proceso',
  'registered': 'Registrado',
  'pending': 'Pendiente',
  'error': 'Error',
};
