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
import 'features/chat/chat.dart';
import 'features/expenses/history_screen.dart';
import 'features/expenses/home_screen.dart';
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
      final public = path == '/login' || path == '/register';
      if (auth.asData?.value == null) return public ? null : '/login';
      return public || path == '/loading' ? '/home' : null;
    },
    routes: [
      GoRoute(path: '/loading', builder: (_, _) => const _SessionScreen()),
      GoRoute(path: '/login', builder: (_, _) => const AuthScreen()),
      GoRoute(
        path: '/register',
        builder: (_, _) => const AuthScreen(register: true),
      ),
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => _MainMenu(shell),
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(path: '/home', builder: (_, _) => const HomeScreen()),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/history',
                builder: (_, state) {
                  final values = state.uri.queryParameters;
                  return HistoryScreen(
                    filters: (
                      from: values['from'],
                      to: values['to'],
                      category: values['category'],
                      status: values['status'],
                    ),
                  );
                },
                routes: [
                  GoRoute(
                    path: ':id',
                    builder: (_, state) =>
                        NoticeScreen(state.pathParameters['id']!),
                  ),
                ],
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
                builder: (_, _) => const _SettingsScreen(),
                routes: [
                  GoRoute(
                    path: 'mailboxes',
                    builder: (_, _) => const MailboxesScreen(),
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

  @override
  void initState() {
    super.initState();
    _links = (widget.links ?? AppLinks().uriLinkStream).listen((link) {
      final origin = ref.read(apiProvider).origin;
      if (link.scheme != 'https' ||
          link.userInfo.isNotEmpty ||
          link.origin != origin.origin ||
          link.path != '/mobile/gmail/return' ||
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
    if (auth.isLoading) return;
    final link = _pending!;
    _pending = null;
    if (auth.asData?.value == null) return;
    final fragment = link.fragment;
    final receipt = RegExp(
      r'^receipt=([A-Za-z0-9_-]{43})$',
    ).firstMatch(fragment)?.group(1);
    final cancelled = fragment == 'status=cancelled';
    if ((!cancelled && receipt == null) ||
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
          if (mounted) unawaited(_resumeLink());
        });
      }
    });
    final colors = ColorScheme.fromSeed(seedColor: const Color(0xFF14532D))
        .copyWith(
          primary: const Color(0xFF14532D),
          onPrimary: Colors.white,
          surface: const Color(0xFFF7F9F7),
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
        inputDecorationTheme: const InputDecorationTheme(
          border: OutlineInputBorder(),
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
          icon: Icon(Icons.receipt_long_outlined),
          label: 'Historial',
        ),
        NavigationDestination(
          icon: Icon(Icons.chat_bubble_outline),
          label: 'Asistente',
        ),
        NavigationDestination(
          icon: Icon(Icons.settings_outlined),
          label: 'Configuración',
        ),
      ],
    ),
  );
}

class _SettingsScreen extends ConsumerWidget {
  const _SettingsScreen();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final account = ref.watch(authProvider).asData?.value;
    return Scaffold(
      appBar: AppBar(title: const Text('Configuración')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (account != null)
            ListTile(
              title: Text(account.name),
              subtitle: Text(account.email),
              leading: const Icon(Icons.person_outline),
            ),
          ListTile(
            leading: const Icon(Icons.mail_outline),
            title: const Text('Buzones'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.go('/settings/mailboxes'),
          ),
          ListTile(
            leading: const Icon(Icons.logout),
            title: const Text('Cerrar sesión'),
            onTap: () => ref.read(authProvider.notifier).logout(),
          ),
        ],
      ),
    );
  }
}
