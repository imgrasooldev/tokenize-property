import 'package:property_token_app/core/bloc/loader_bloc.dart';
import 'package:property_token_app/features/portfolio/domain/portfolio.dart';

class PortfolioBloc extends LoaderBloc<Portfolio> {
  PortfolioBloc(PortfolioRepository repo) : super(repo.portfolio);
}
