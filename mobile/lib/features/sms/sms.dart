import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/design.dart';
import '../../core/format.dart';
import '../../core/sms_bridge.dart';
import '../../core/widgets.dart';
import '../auth/auth.dart';
import '../expenses/finance.dart';

class SmsScreen extends ConsumerStatefulWidget {
  const SmsScreen({super.key});
  @override
  ConsumerState<SmsScreen> createState() => _SmsScreenState();
}

class _SmsScreenState extends ConsumerState<SmsScreen>
    with WidgetsBindingObserver {
  SmsStatus? _status;
  Timer? _timer;
  bool _busy = false, _reading = false;
  bool _visible = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_read());
    _startTimer();
  }

  void _startTimer() {
    _timer?.cancel();
    if (_visible) {
      _timer = Timer.periodic(const Duration(seconds: 5), (_) => _read());
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _visible = TickerMode.valuesOf(context).enabled;
    if (_visible) {
      _startTimer();
    } else {
      _timer?.cancel();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_read());
      _startTimer();
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _timer?.cancel();
    }
  }

  Future<void> _read() async {
    if (_reading || _busy || !_visible) return;
    _reading = true;
    try {
      final next = await ref.read(smsBridgeProvider).status();
      if (!mounted) return;
      if (_status?.lastSync != next.lastSync) {
        refreshImportedData(ref);
      }
      setState(() {
        _status = next;
      });
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'No pudimos consultar la conexión de SMS.');
      }
    } finally {
      _reading = false;
    }
  }

  Future<void> _enable() async {
    if (_busy) return;
    final account = ref.read(authProvider).asData?.value;
    if (account == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final bridge = ref.read(smsBridgeProvider);
      if (!await bridge.requestPermissions()) {
        throw const ApiFailure(
          'No se concedió el permiso de SMS. Puedes activarlo desde los permisos de Android.',
        );
      }
      final local = await bridge.status();
      final api = ref.read(apiProvider);
      final device = await api.object(
        'sms/devices',
        method: 'POST',
        body: {
          'deviceId': local.deviceId,
          'autoDetect': true,
          'name': 'Android MailGasto',
        },
      );
      if (ref.read(authProvider).asData?.value?.id != account.id) return;
      final next = await bridge.configure({
        'accountId': account.id,
        'origin': api.origin.origin,
        'serverId': device['id'],
        'ingestToken': device['ingestToken'],
        'senders': device['senders'],
        'since': device['since'],
      });
      if (mounted) setState(() => _status = next);
    } catch (error) {
      if (mounted) setState(() => _error = failureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _disable() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final serverId = _status?.serverId;
    try {
      final bridge = ref.read(smsBridgeProvider);
      await bridge.clear();
      final next = await bridge.status();
      if (mounted) setState(() => _status = next);
      if (serverId != null) {
        await ref
            .read(apiProvider)
            .request(
              'sms/devices/${Uri.encodeComponent(serverId)}',
              method: 'DELETE',
            );
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'SMS desactivado en este teléfono. No pudimos confirmar la revocación en el servidor.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final status = _status;
    return Scaffold(
      appBar: appBackBar('Perfil', () => context.pop()),
      body: ListView(
        padding: screenPadding,
        children: [
          const PageHeading(
            'SMS de Nequi',
            eyebrow: 'CONEXIONES',
            description:
                'Registra entradas y salidas que llegan por mensaje de texto.',
          ),
          const SizedBox(height: 14),
          const AppNotice(
            icon: Icons.sms_outlined,
            title: 'Identificación automática en el teléfono',
            description:
                'Al activar, MailGasto revisará localmente los SMS desde el 1 de noviembre e identificará los de Nequi. Sólo enviará a tu cuenta avisos de entradas o salidas efectivas. Los mensajes personales, códigos de acceso y publicidad se quedan fuera de la importación.',
          ),
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: _busy ? null : _enable,
            icon: const Icon(Icons.sms_outlined),
            label: Text(
              _busy
                  ? 'Configurando…'
                  : status?.enabled == true
                  ? 'Renovar conexión de SMS'
                  : 'Activar SMS de Nequi',
            ),
          ),
          if (status != null) ...[
            const SizedBox(height: 14),
            DetailFields([
              (
                'Estado',
                status.enabled
                    ? status.permission
                          ? 'Activo'
                          : 'Permiso desactivado'
                    : 'Desactivado',
              ),
              ('Desde', shortDay(status.since)),
              ('Por enviar', '${status.queued}'),
            ]),
            const SizedBox(height: 12),
            const SectionHeading('Último lote enviado'),
            DetailFields([
              ('Registrados', '${status.imported}'),
              ('Ya existentes', '${status.duplicates}'),
              if (status.ignored > 0)
                ('Sin movimiento efectivo', '${status.ignored}'),
              if (status.pending > 0)
                ('Datos insuficientes', '${status.pending}'),
              if (status.lastSync case final sync?)
                ('Último envío', syncLabel(sync)),
            ]),
            if (status.explanation case final explanation?) ...[
              const SizedBox(height: 10),
              AppNotice(icon: Icons.info_outline, title: explanation),
            ],
            if (status.serverId != null) ...[
              const SizedBox(height: 10),
              OutlinedButton(
                onPressed: _busy ? null : _disable,
                child: const Text('Desactivar SMS'),
              ),
            ],
            if (!status.permission) ...[
              const SizedBox(height: 8),
              TextButton(
                onPressed: _busy
                    ? null
                    : () => ref.read(smsBridgeProvider).settings(),
                child: const Text('Permisos de Android'),
              ),
            ],
          ],
          if (_error case final error?) ...[
            const SizedBox(height: 12),
            AppNotice(
              icon: Icons.error_outline,
              title: error,
              tone: AppTone.danger,
            ),
          ],
          const SizedBox(height: 12),
          Text(
            'Los nuevos SMS se revisan en segundo plano y los envíos se reintentan con conexión. Si Android fuerza la detención de la app, vuelve a abrirla para reanudar.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}
