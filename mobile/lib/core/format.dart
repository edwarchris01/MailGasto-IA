import 'package:intl/intl.dart';
import 'package:timezone/timezone.dart' as tz;

DateTime bogotaNow() => tz.TZDateTime.now(tz.getLocation('America/Bogota'));

String isoDay(DateTime date) => DateFormat('yyyy-MM-dd').format(date);

String dayLabel(String value) =>
    DateFormat('dd/MM/yyyy', 'es_CO').format(DateTime.parse(value));

String syncLabel(String value) =>
    DateFormat('dd/MM/yyyy HH:mm', 'es_CO').format(
      tz.TZDateTime.from(
        DateTime.parse(value),
        tz.getLocation('America/Bogota'),
      ),
    );

String money(BigInt minor, String currency) {
  final units = (minor ~/ BigInt.from(100)).toString().replaceAllMapped(
    RegExp(r'\B(?=(\d{3})+(?!\d))'),
    (_) => '.',
  );
  final cents = (minor % BigInt.from(100)).toString().padLeft(2, '0');
  return '$currency $units,$cents';
}

const categories = {
  'alimentacion': 'Alimentación',
  'transporte': 'Transporte',
  'vivienda': 'Vivienda',
  'ocio': 'Ocio',
  'salud': 'Salud',
  'educacion': 'Educación',
  'ingresos': 'Ingresos',
  'otros': 'Otros',
};

const noticeStatuses = {
  'processing': 'En proceso',
  'registered': 'Registrado',
  'pending': 'Pendiente',
  'error': 'Error',
};
