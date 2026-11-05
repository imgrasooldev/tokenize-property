import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:go_router/go_router.dart';
import 'package:property_token_app/core/bloc/loader_bloc.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/core/theme/app_theme.dart';
import 'package:property_token_app/features/account/domain/me.dart';
import 'package:property_token_app/features/account/presentation/account_bloc.dart';
import 'package:property_token_app/features/account/presentation/account_page.dart';
import 'package:property_token_app/features/auth/domain/auth_repository.dart';
import 'package:property_token_app/features/auth/presentation/auth_bloc.dart';
import 'package:property_token_app/features/auth/presentation/sign_in_page.dart';
import 'package:property_token_app/features/inbox/domain/message.dart';
import 'package:property_token_app/features/inbox/presentation/inbox_bloc.dart';
import 'package:property_token_app/features/inbox/presentation/inbox_page.dart';
import 'package:property_token_app/features/invest/domain/invest.dart';
import 'package:property_token_app/features/invest/presentation/change_cubit.dart';
import 'package:property_token_app/features/invest/presentation/change_page.dart';
import 'package:property_token_app/features/invest/presentation/invest_cubit.dart';
import 'package:property_token_app/features/invest/presentation/invest_page.dart';
import 'package:property_token_app/features/market/domain/market.dart';
import 'package:property_token_app/features/market/presentation/market_bloc.dart';
import 'package:property_token_app/features/market/presentation/market_page.dart';
import 'package:property_token_app/features/market/presentation/order_cancel_page.dart';
import 'package:property_token_app/features/market/presentation/order_cubit.dart';
import 'package:property_token_app/features/market/presentation/order_page.dart';
import 'package:property_token_app/features/market/presentation/top_up_cubit.dart';
import 'package:property_token_app/features/market/presentation/top_up_page.dart';
import 'package:property_token_app/features/offerings/domain/offering.dart';
import 'package:property_token_app/features/offerings/presentation/offerings_bloc.dart';
import 'package:property_token_app/features/offerings/presentation/offerings_page.dart';
import 'package:property_token_app/features/portfolio/domain/portfolio.dart';
import 'package:property_token_app/features/portfolio/presentation/portfolio_bloc.dart';
import 'package:property_token_app/features/portfolio/presentation/portfolio_page.dart';
import 'package:property_token_app/features/rent/domain/rent.dart';
import 'package:property_token_app/features/rent/presentation/rent_bloc.dart';
import 'package:property_token_app/features/rent/presentation/rent_page.dart';
import 'package:property_token_app/features/settings/settings_cubit.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

/// The repositories the app needs (dependency injection at the root: tests pass fakes).
class AppRepositories {
  const AppRepositories({
    required this.auth,
    required this.offerings,
    required this.portfolio,
    required this.inbox,
    required this.account,
    required this.rent,
    required this.invest,
    required this.market,
    this.api,
  });

  final AuthRepository auth;
  final OfferingsRepository offerings;
  final PortfolioRepository portfolio;
  final InboxRepository inbox;
  final AccountRepository account;
  final RentRepository rent;
  final InvestRepository invest;
  final MarketRepository market;

  /// The HTTP client, told the language for Accept-Language (absent in widget tests).
  final ApiClient? api;
}

class PropertyTokenApp extends StatefulWidget {
  const PropertyTokenApp({required this.repositories, super.key, this.authBloc});

  final AppRepositories repositories;

  /// Injected in tests (to control polling); otherwise created here.
  final AuthBloc? authBloc;

  @override
  State<PropertyTokenApp> createState() => _PropertyTokenAppState();
}

class _PropertyTokenAppState extends State<PropertyTokenApp> {
  late final AuthBloc _auth = widget.authBloc ?? AuthBloc(widget.repositories.auth)
    ..add(const AuthStarted());
  late final SettingsCubit _settings = SettingsCubit();
  late final GoRouter _router = _buildRouter(_auth);

  @override
  void dispose() {
    _router.dispose();
    unawaited(_auth.close());
    unawaited(_settings.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.repositories;
    return MultiRepositoryProvider(
      providers: [
        RepositoryProvider.value(value: r.auth),
        RepositoryProvider.value(value: r.offerings),
        RepositoryProvider.value(value: r.portfolio),
        RepositoryProvider.value(value: r.inbox),
        RepositoryProvider.value(value: r.account),
        RepositoryProvider.value(value: r.rent),
        RepositoryProvider.value(value: r.invest),
        RepositoryProvider.value(value: r.market),
      ],
      child: MultiBlocProvider(
        providers: [
          BlocProvider.value(value: _auth),
          BlocProvider.value(value: _settings),
        ],
        child: BlocBuilder<SettingsCubit, Settings>(
          builder: (context, s) {
            r.api?.language = s.locale.languageCode;
            return MaterialApp.router(
              onGenerateTitle: (c) => AppLocalizations.of(c).appTitle,
              theme: AppTheme.light,
              darkTheme: AppTheme.dark,
              themeMode: s.themeMode,
              locale: s.locale,
              supportedLocales: AppLocalizations.supportedLocales,
              localizationsDelegates: const [
                AppLocalizations.delegate,
                GlobalMaterialLocalizations.delegate,
                GlobalWidgetsLocalizations.delegate,
                GlobalCupertinoLocalizations.delegate,
              ],
              routerConfig: _router,
            );
          },
        ),
      ),
    );
  }
}

/// Re-runs the router's redirect whenever the sign-in state changes.
class _AuthListenable extends ChangeNotifier {
  _AuthListenable(Stream<AuthState> s) {
    _sub = s.listen((_) => notifyListeners());
  }
  late final StreamSubscription<AuthState> _sub;

  @override
  void dispose() {
    unawaited(_sub.cancel());
    super.dispose();
  }
}

GoRouter _buildRouter(AuthBloc auth) => GoRouter(
  initialLocation: '/discover',
  refreshListenable: _AuthListenable(auth.stream),
  redirect: (context, state) {
    final signedIn = auth.state is AuthSignedIn;
    final onSignIn = state.matchedLocation == '/sign-in';
    if (auth.state is AuthUnknown) return null;
    if (!signedIn && !onSignIn) return '/sign-in';
    if (signedIn && onSignIn) return '/discover';
    return null;
  },
  routes: [
    GoRoute(path: '/sign-in', builder: (_, _) => const SignInPage()),
    GoRoute(
      path: '/rent',
      builder: (c, _) => BlocProvider(
        create: (_) => RentBloc(c.read<RentRepository>())..add(const LoadRequested()),
        child: const RentPage(),
      ),
    ),
    GoRoute(
      path: '/invest',
      redirect: (_, state) => state.extra is Offering ? null : '/discover',
      builder: (c, state) {
        final offering = state.extra! as Offering;
        return BlocProvider(
          create: (_) => InvestCubit(c.read<InvestRepository>(), offeringId: offering.id),
          child: InvestPage(offering: offering),
        );
      },
    ),
    GoRoute(
      path: '/market',
      builder: (c, _) => BlocProvider(
        create: (_) => MarketBloc(c.read<MarketRepository>())..add(const LoadRequested()),
        child: const MarketPage(),
      ),
    ),
    GoRoute(
      path: '/market/order',
      redirect: (_, state) => state.extra is MarketBook ? null : '/market',
      builder: (c, state) {
        final m = state.extra! as MarketBook;
        return BlocProvider(
          create: (_) => OrderCubit(c.read<MarketRepository>(), symbol: m.symbol),
          child: OrderPage(market: m),
        );
      },
    ),
    GoRoute(
      path: '/market/cancel',
      redirect: (_, state) => state.extra is MarketOrder ? null : '/market',
      builder: (c, state) {
        final o = state.extra! as MarketOrder;
        return BlocProvider(
          create: (_) => OrderCubit(c.read<MarketRepository>(), symbol: o.symbol),
          child: OrderCancelPage(order: o),
        );
      },
    ),
    GoRoute(
      path: '/market/topup',
      builder: (c, _) => BlocProvider(
        create: (_) => TopUpCubit(c.read<MarketRepository>()),
        child: const TopUpPage(),
      ),
    ),
    GoRoute(
      path: '/subscription-change',
      redirect: (_, state) => state.extra is Subscription ? null : '/portfolio',
      builder: (c, state) {
        final sub = state.extra! as Subscription;
        return BlocProvider(
          create: (_) => ChangeCubit(c.read<InvestRepository>(), subscriptionId: sub.id),
          child: ChangePage(subscription: sub),
        );
      },
    ),
    StatefulShellRoute.indexedStack(
      builder: (context, state, shell) => _HomeShell(shell: shell),
      branches: [
        _branch(
          '/discover',
          (c) => BlocProvider(
            create: (_) => OfferingsBloc(c.read<OfferingsRepository>())..add(const LoadRequested()),
            child: const OfferingsPage(),
          ),
        ),
        _branch(
          '/portfolio',
          (c) => BlocProvider(
            create: (_) => PortfolioBloc(c.read<PortfolioRepository>())..add(const LoadRequested()),
            child: const PortfolioPage(),
          ),
        ),
        _branch(
          '/inbox',
          (c) => BlocProvider(
            create: (_) => InboxBloc(c.read<InboxRepository>())..add(const InboxRefreshed()),
            child: const InboxPage(),
          ),
        ),
        _branch(
          '/account',
          (c) => BlocProvider(
            create: (_) => AccountBloc(c.read<AccountRepository>())..add(const LoadRequested()),
            child: const AccountPage(),
          ),
        ),
      ],
    ),
  ],
);

StatefulShellBranch _branch(String path, Widget Function(BuildContext) page) => StatefulShellBranch(
  routes: [GoRoute(path: path, builder: (context, _) => page(context))],
);

class _HomeShell extends StatelessWidget {
  const _HomeShell({required this.shell});

  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      body: shell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex,
        onDestinationSelected: (i) => shell.goBranch(i, initialLocation: i == shell.currentIndex),
        destinations: [
          NavigationDestination(
            icon: const Icon(Icons.explore_outlined),
            selectedIcon: const Icon(Icons.explore),
            label: l.tabDiscover,
          ),
          NavigationDestination(
            icon: const Icon(Icons.pie_chart_outline),
            selectedIcon: const Icon(Icons.pie_chart),
            label: l.tabPortfolio,
          ),
          NavigationDestination(
            icon: const Icon(Icons.inbox_outlined),
            selectedIcon: const Icon(Icons.inbox),
            label: l.tabInbox,
          ),
          NavigationDestination(
            icon: const Icon(Icons.person_outline),
            selectedIcon: const Icon(Icons.person),
            label: l.tabAccount,
          ),
        ],
      ),
    );
  }
}
