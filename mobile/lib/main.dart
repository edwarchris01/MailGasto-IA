import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:timezone/data/latest.dart' as tz;

import 'core/api.dart';
import 'core/widgets.dart';
import 'features/auth/auth.dart';
import 'features/auth/profile.dart';
import 'features/chat/chat.dart';
import 'features/expenses/finance.dart';
import 'features/expenses/finance_screens.dart';
import 'features/expenses/history_screen.dart';
import 'features/expenses/movements_screen.dart';
import 'features/mailboxes/mailboxes.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  tz.initializeTimeZones();
  runApp(const ProviderScope(child: MailGastoApp()));
}

final routerProvider = Provider((ref) {
  final router = GoRouter(
    initialLocation: '/loading',
    redirect: (context, route) {
      final auth = ref.read(authProvider);
      final path = route.matchedLocation;
      if (auth.isLoading || auth.hasError) {
        return path == '/loading' ? null : '/loading';
      }
      final access = path == '/login' || path == '/register';
      final recovery = path == '/recover' || path == '/reset';
      if (auth.asData?.value == null) {
        return access || recovery ? null : '/login';
      }
      return access || path == '/loading' ? '/home' : null;
    },
    routes: [
      GoRoute(path: '/loading', builder: (_, _) => const _SessionScreen()),
      GoRoute(path: '/login', builder: (_, _) => const AuthScreen()),
      GoRoute(path: '/recover', builder: (_, _) => const RecoverScreen()),
      GoRoute(
        path: '/reset',
        builder: (_, state) =>
            PasswordScreen(reset: true, token: state.extra as String?),
      ),
      GoRoute(
        path: '/register',
        builder: (_, _) => const AuthScreen(register: true),
      ),
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => _MainMenu(shell),
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/home',
                builder: (_, _) => const FinanceScreen(home: true),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/history',
                builder: (_, state) =>
                    MovementsScreen(state.uri.queryParameters),
                routes: [
                  GoRoute(
                    path: 'new',
                    builder: (_, state) => MovementForm(
                      direction: state.uri.queryParameters['direction'],
                      currency: state.uri.queryParameters['currency'],
                    ),
                  ),
                  GoRoute(
                    path: 'movement/:id',
                    builder: (_, state) =>
                        MovementScreen(state.pathParameters['id']!),
                    routes: [
                      GoRoute(
                        path: 'edit',
                        builder: (_, state) => MovementScreen(
                          state.pathParameters['id']!,
                          editing: true,
                        ),
                      ),
                    ],
                  ),
                  GoRoute(
                    path: ':id',
                    builder: (_, state) =>
                        NoticeScreen(state.pathParameters['id']!),
                    routes: [
                      GoRoute(
                        path: 'confirm',
                        builder: (_, state) => NoticeScreen(
                          state.pathParameters['id']!,
                          confirming: true,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/analysis',
                builder: (_, state) {
                  final values = state.uri.queryParameters;
                  final defaults = currentRange();
                  return FinanceScreen(
                    key: ValueKey(state.uri),
                    initial: (
                      from: values['from'] ?? defaults.from,
                      to: values['to'] ?? defaults.to,
                      currency: currencies.containsKey(values['currency'])
                          ? values['currency']!
                          : defaults.currency,
                    ),
                  );
                },
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/assistant',
                builder: (_, _) => const ChatScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/settings',
                builder: (_, _) => const ProfileScreen(),
                routes: [
                  GoRoute(
                    path: 'mailboxes',
                    builder: (_, _) => const MailboxesScreen(),
                  ),
                  GoRoute(
                    path: 'security',
                    builder: (_, _) => const SecurityScreen(),
                    routes: [
                      GoRoute(
                        path: 'password',
                        builder: (_, _) => const PasswordScreen(),
                      ),
                      GoRoute(
                        path: 'delete',
                        builder: (_, state) =>
                            DeleteAccountScreen(state.extra as String?),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
  ref.listen(authProvider, (_, _) => router.refresh());
  ref.onDispose(router.dispose);
  return router;
});

class MailGastoApp extends ConsumerStatefulWidget {
  const MailGastoApp({super.key, this.links});
  final Stream<Uri>? links;

  @override
  ConsumerState<MailGastoApp> createState() => _MailGastoAppState();
}

class _MailGastoAppState extends ConsumerState<MailGastoApp> {
  final _messenger = GlobalKey<ScaffoldMessengerState>();
  StreamSubscription<Uri>? _links;
  Uri? _pending;
  bool _processing = false;
  String? _lastReceipt;
  String? _pendingDeletion;

  @override
  void initState() {
    super.initState();
    _links = (widget.links ?? AppLinks().uriLinkStream).listen((link) {
      final origin = ref.read(apiProvider).origin;
      if (link.scheme != 'https' ||
          link.userInfo.isNotEmpty ||
          link.origin != origin.origin ||
          !const {
            '/mobile/gmail/return',
            '/mobile/auth/google/return',
            '/mobile/auth/reset',
            '/mobile/auth/delete',
          }.contains(link.path) ||
          link.hasQuery) {
        return;
      }
      _pending = link;
      unawaited(_resumeLink());
    }, onError: (Object _) {});
  }

  Future<void> _resumeLink() async {
    if (_pending == null || _processing) return;
    final auth = ref.read(authProvider);
    if (auth.isLoading || auth.hasError) return;
    final link = _pending!;
    _pending = null;
    final fragment = link.fragment;
    if (link.path == '/mobile/auth/reset') {
      final token = RegExp(
        r'^reset=([A-Za-z0-9_-]{43})$',
      ).firstMatch(fragment)?.group(1);
      ref.read(routerProvider).go('/reset', extra: token);
      return;
    }
    if (link.path == '/mobile/auth/delete') {
      _pendingDeletion = RegExp(
        r'^delete=([A-Za-z0-9_-]{43})$',
      ).firstMatch(fragment)?.group(1);
      if (_pendingDeletion == null) {
        _messenger.currentState?.showSnackBar(
          const SnackBar(
            content: Text('El enlace de eliminación es inválido.'),
          ),
        );
      } else if (auth.asData?.value == null) {
        ref.read(routerProvider).go('/login');
        _messenger.currentState?.showSnackBar(
          const SnackBar(
            content: Text('Inicia sesión para confirmar la eliminación.'),
          ),
        );
      } else {
        _openDeletion();
      }
      return;
    }
    final receipt = RegExp(
      r'^receipt=([A-Za-z0-9_-]{43})$',
    ).firstMatch(fragment)?.group(1);
    final cancelled = fragment == 'status=cancelled';
    final failed = fragment == 'status=failed';
    if (link.path == '/mobile/auth/google/return') {
      if (auth.asData?.value == null) await _resumeGoogle(fragment, receipt);
      return;
    }
    if (auth.asData?.value == null) return;
    if ((!cancelled && !failed && receipt == null) ||
        (receipt != null && receipt == _lastReceipt)) {
      return;
    }

    final session = ref.read(apiProvider).session;
    ref.read(routerProvider).go('/settings/mailboxes');
    _processing = true;
    String message;
    try {
      if (cancelled) {
        message = 'La vinculación se canceló.';
      } else if (failed) {
        message = 'No pudimos vincular Gmail. Vuelve a iniciar la vinculación.';
      } else {
        _lastReceipt = receipt;
        await ref.read(mailboxRepositoryProvider).complete(receipt!);
        message = 'Buzón vinculado.';
      }
    } catch (error) {
      message = failureMessage(error);
    } finally {
      _processing = false;
    }
    if (!mounted) return;
    if (ref.read(apiProvider).session == session && session != null) {
      ref.invalidate(mailboxesProvider);
      _messenger.currentState?.showSnackBar(SnackBar(content: Text(message)));
    }
    if (_pending != null) unawaited(_resumeLink());
  }

  void _openDeletion() {
    final token = _pendingDeletion;
    if (token == null || ref.read(authProvider).asData?.value == null) return;
    _pendingDeletion = null;
    ref.read(routerProvider).go('/settings/security/delete', extra: token);
  }

  Future<void> _resumeGoogle(String fragment, String? receipt) async {
    if (receipt == _lastReceipt && receipt != null) return;
    final auth = ref.read(authProvider.notifier);
    _processing = true;
    try {
      if (receipt == null) {
        await auth.cancelGoogle();
        throw ApiFailure(
          fragment == 'status=cancelled'
              ? 'Se canceló el acceso con Google.'
              : 'Google no pudo iniciar sesión. Vuelve a intentar o usa tu correo.',
        );
      }
      await auth.finishGoogle(receipt);
      _lastReceipt = receipt;
    } catch (error) {
      _messenger.currentState?.showSnackBar(
        SnackBar(content: Text(failureMessage(error))),
      );
    } finally {
      _processing = false;
    }
    if (mounted && _pending != null) unawaited(_resumeLink());
  }

  @override
  void dispose() {
    unawaited(_links?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(authProvider, (_, next) {
      if (next.hasValue) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) {
            _openDeletion();
            unawaited(_resumeLink());
          }
        });
      }
    });
    final colors = ColorScheme.fromSeed(seedColor: const Color(0xFF2945DB))
        .copyWith(
          primary: const Color(0xFF2945DB),
          onPrimary: Colors.white,
          surface: const Color(0xFFF5F7FF),
          onSurface: const Color(0xFF111A40),
        );
    return MaterialApp.router(
      title: 'MailGasto IA',
      scaffoldMessengerKey: _messenger,
      routerConfig: ref.watch(routerProvider),
      debugShowCheckedModeBanner: false,
      locale: const Locale('es', 'CO'),
      supportedLocales: const [Locale('es', 'CO')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: colors,
        scaffoldBackgroundColor: colors.surface,
        cardTheme: const CardThemeData(
          color: Colors.white,
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.all(Radius.circular(18)),
            side: BorderSide(color: Color(0xFFE0E5F2)),
          ),
        ),
        inputDecorationTheme: const InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.all(Radius.circular(12)),
          ),
        ),
      ),
    );
  }
}

class _SessionScreen extends ConsumerWidget {
  const _SessionScreen();

  @override
  Widget build(BuildContext context, WidgetRef ref) => Scaffold(
    body: ref
        .watch(authProvider)
        .when(
          data: (_) => const Center(child: CircularProgressIndicator()),
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) =>
              RetryMessage(error, () => ref.invalidate(authProvider)),
        ),
  );
}

class _MainMenu extends StatelessWidget {
  const _MainMenu(this.shell);
  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: shell,
    bottomNavigationBar: NavigationBar(
      backgroundColor: Colors.white,
      labelBehavior: MediaQuery.textScalerOf(context).scale(16) > 21
          ? NavigationDestinationLabelBehavior.onlyShowSelected
          : NavigationDestinationLabelBehavior.alwaysShow,
      selectedIndex: shell.currentIndex,
      onDestinationSelected: (index) =>
          shell.goBranch(index, initialLocation: index == shell.currentIndex),
      destinations: const [
        NavigationDestination(
          icon: Icon(Icons.home_outlined),
          selectedIcon: Icon(Icons.home),
          label: 'Inicio',
        ),
        NavigationDestination(
          icon: Icon(Icons.swap_horiz),
          label: 'Movimientos',
        ),
        NavigationDestination(icon: Icon(Icons.bar_chart), label: 'Análisis'),
        NavigationDestination(
          icon: Icon(Icons.chat_bubble_outline),
          label: 'Asistente',
        ),
        NavigationDestination(
          icon: Icon(Icons.person_outline),
          label: 'Perfil',
        ),
      ],
    ),
  );
}
