const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

app.post('/api/consulta', async (req, res) => {
    // Captura o usuário e senha digitados no index.html (Totalmente Dinâmico)
    const { user, senha } = req.body;

    if (!user || !senha) {
        return res.status(400).json({ error: 'RA e senha são obrigatórios.' });
    }

    try {
        const browserHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
        };

        // ==========================================================
        // [#2] LOGIN SED - AUTENTICAÇÃO PRIMÁRIA
        // ==========================================================
        const loginResponse = await axios.post(
            'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken',
            { user, senha },
            {
                headers: {
                    ...browserHeaders,
                    'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
                    'X-Product-Name': 'SalaDoFuturo',
                    'Content-Type': 'application/json'
                }
            }
        );

        // Captura o token LONGO e os dados dinâmicos do usuário conectado
        const tokenLongoSED = loginResponse.data.token;
        const dadosUsuario = loginResponse.data.DadosUsuario;

        if (!tokenLongoSED || !dadosUsuario || !dadosUsuario.CD_USUARIO) {
            return res.status(401).json({ error: 'Falha na leitura dos dados de autenticação da SED.' });
        }

        // CAPTURA DINÂMICA: Armazena o ID do usuário atual logado
        const codigoAluno = dadosUsuario.CD_USUARIO; 

        // Header padrão para as próximas chamadas da SED (Obrigatório conter o Bearer Token)
        const sedAuthHeaders = {
            ...browserHeaders,
            'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
            'X-Product-Name': 'SalaDoFuturo',
            'Authorization': `Bearer ${tokenLongoSED}`
        };

        // Inicialização das variáveis que vão coletar as respostas
        let infoEscola = {};
        let escolaId = 0;
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        let totalAvaliacoes = 0;

        // ==========================================================
        // [#3] CONSULTA DE TURMA (SED) - Usando o ID dinâmico
        // ==========================================================
        try {
            const dadosEscolares = await axios.get(
                `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${codigoAluno}`, 
                { headers: sedAuthHeaders }
            );
            if (dadosEscolares.data && dadosEscolares.data[0]) {
                infoEscola = dadosEscolares.data[0];
                escolaId = infoEscola.CodigoEscola || 0; // Captura o ID da escola dinamicamente
            }
        } catch (e) {
            console.warn('Erro na rota #3 (Turma):', e.message);
        }

        // ==========================================================
        // [#4] CONSULTA DE BIMESTRES (SED) - Usando Escola Dinâmica
        // ==========================================================
        try {
            if (escolaId > 0) {
                await axios.get(
                    `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apihubintegracoes/api/Bimestre/ListarBimestres?escolaId=${escolaId}`,
                    { headers: sedAuthHeaders }
                );
            }
        } catch (e) {
            console.warn('Erro na rota #4 (Bimestres):', e.message);
        }

        // ==========================================================
        // [#5] HANDSHAKE IP.TV - LIMPO, SEM CHAVES DA SED
        // ==========================================================
        try {
            const iptvTokenResponse = await axios.post(
                'https://edusp-api.ip.tv/registration/edusp/token',
                { token: tokenLongoSED }, // Token longo enviado de forma idêntica
                {
                    headers: {
                        'Host': 'edusp',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'x-api-realm': 'edusp',
                        'x-api-platform': 'webclient',
                        'Origin': 'https://saladofuturo.educacao.sp.gov.br',
                        'Referer': 'https://saladofuturo.educacao.sp.gov.br/'
                    }
                }
            );

            // Esse é o Token gerado e assinado pela IP.TV
            const auth_token_iptv = iptvTokenResponse.data.auth_token;

            if (auth_token_iptv) {
                // Headers específicos exigidos pelas APIs de dados da IP.TV
                const iptvDataHeaders = {
                    'Host': 'edusp',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'x-api-key': auth_token_iptv // Chave IP.TV injetada aqui
                };

                // Coleta da contagem de tarefas pendentes e expiradas
                const pendenciasResponse = await axios.get(
                    'https://edusp-api.ip.tv/tms/task/todo/count?filter_expired=true', 
                    { headers: iptvDataHeaders }
                );
                tarefasPendentes = pendenciasResponse.data.todo || 0;
                tarefasExpiradas = pendenciasResponse.data.expired || 0;
            }
        } catch (e) {
            console.warn('Erro no handshake/dados da IP.TV:', e.message);
        }

        // ==========================================================
        // [#26] CONSULTA DE AVALIAÇÕES (SED) - Dinâmico
        // ==========================================================
        try {
            const avaliacoesResponse = await axios.get(
                `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${codigoAluno}&AnoLetivo=2026`, 
                { headers: sedAuthHeaders }
            );
            if (Array.isArray(avaliacoesResponse.data)) {
                totalAvaliacoes = avaliacoesResponse.data.length;
            }
        } catch (e) {
            console.warn('Erro na rota #26 (Avaliações):', e.message);
        }

        // Retorna a estrutura consolidada em tempo real para o index.html
        res.json({
            aluno: {
                codigo: codigoAluno,
                escola: infoEscola.NomeEscola || 'Não Informada',
                turma: infoEscola.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: tarefasPendentes,
                expiradas: tarefasExpiradas,
                avaliacoes: totalAvaliacoes,
                redacoes: 0
            }
        });

    } catch (error) {
        console.error('Erro geral no barramento:', error.message);
        res.status(500).json({ error: 'Erro ao processar dados no servidor administrativo.' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF 100% Dinâmico ativo na porta ${PORT}`));
