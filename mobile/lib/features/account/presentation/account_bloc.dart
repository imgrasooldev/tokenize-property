import 'package:property_token_app/core/bloc/loader_bloc.dart';
import 'package:property_token_app/features/account/domain/me.dart';

class AccountBloc extends LoaderBloc<Me> {
  AccountBloc(AccountRepository repo) : super(repo.me);
}
