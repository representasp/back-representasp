const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    if (!user || !senha) {
        return res.status(400).json({ error: 'RA e senha are obrigatórios.' });
    }

    try {
        const browserHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
        };

        // ==========================================================
        // [LOG #2] LOGIN SED - AUTENTICAÇÃO PRIMÁRIA
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

        let tokenLongoSED = loginResponse.data.token;
        const dadosUsuario = loginResponse.data.DadosUsuario;

        if (!tokenLongoSED || !dadosUsuario || !dadosUsuario.CD_USUARIO) {
            return res.status(401).json({ error: 'Falha na leitura dos dados de autenticação da SED.' });
        }

        // Sanitização e formatação do token
        tokenLongoSED = tokenLongoSED.toString().trim().replace(/[\r\n]/g, "");
        const tokenFormatado = tokenLongoSED.startsWith('Bearer') ? tokenLongoSED : `Bearer ${tokenLongoSED}`;

        // Definição dos IDs dinâmicos (9 dígitos e truncado para 8 dígitos)
        const codigoAluno9Digitos = dadosUsuario.CD_USUARIO.toString().trim(); 
        const codigoAluno8Digitos = codigoAluno9Digitos.slice(0, -1);

        console.log(`[BFF] Sessão Iniciada -> Aluno 9D: ${codigoAluno9Digitos} | Aluno 8D: ${codigoAluno8Digitos}`);

        // Headers padrão para as comunicações com a SED
        const sedAuthHeaders = {
            ...browserHeaders,
            'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
            'X-Product-Name': 'SalaDoFuturo',
            'Authorization': tokenFormatado
        };

        // ==========================================================
        // [LOG #10] REGISTRO DE TOKEN CMSP - DESBLOQUEIA AS CONSULTAS
        // ==========================================================
        try {
            await axios.post(
                'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/cmspwebservice/api/sala-do-futuro-alunos/registrar-usuario-token',
                {
                    userId: codigoAluno9Digitos, // Usa obrigatoriamente os 9 dígitos aqui
                    deviceToken: "",
                    typeDeviceToken: "DESKTOP"
                },
                { headers: sedAuthHeaders }
            );
            console.log('[BFF] Token registrado com sucesso no barramento CMSP.');
        } catch (e) {
            console.warn('Aviso: Falha ou ignorado no registro CMSP:', e.message);
        }

        // Inicialização de variáveis de retorno
        let infoEscola = {};
        let escolaId = 0;
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        let totalAvaliacoes = 0;

        // ==========================================================
        // [LOG #3] CONSULTA DE TURMA (SED) - ID de 8 Dígitos
        // ==========================================================
        try {
            const dadosEscolares = await axios.get(
                `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${codigoAluno8Digitos}`, 
                { headers: sedAuthHeaders }
            );
            if (dadosEscolares.data && dadosEscolares.data[0]) {
                infoEscola = dadosEscolares.data[0];
                escolaId = infoEscola.CodigoEscola || 0;
            }
        } catch (e) {
            console.error('Erro na rota #3 (Turma):', e.response?.data || e.message);
        }

        // ==========================================================
        // [LOG #4] CONSULTA DE BIMESTRES (SED) - ID de Escola Dinâmico
        // ==========================================================
        try {
            if (escolaId > 0) {
                await axios.get(
                    `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apihubintegracoes/api/Bimestre/ListarBimestres?escolaId=${escolaId}`,
                    { headers: sedAuthHeaders }
                );
            }
        } catch (e) {
            console.error('Erro na rota #4 (Bimestres):', e.response?.data || e.message);
        }

        // ==========================================================
        // [LOG #5] HANDSHAKE E TAREFAS (IP.TV)
        // ==========================================================
        try {
            const iptvTokenResponse = await axios.post(
                'https://edusp-api.ip.tv/registration/edusp/token',
                { token: tokenLongoSED }, 
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

            const auth_token_iptv = iptvTokenResponse.data.auth_token;

            if (auth_token_iptv) {
                const iptvDataHeaders = {
                    'Host': 'edusp',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'x-api-key': auth_token_iptv 
                };

                const pendenciasResponse = await axios.get(
                    'https://edusp-api.ip.tv/tms/task/todo/count?filter_expired=true&publication_target=vialv', 
                    { headers: iptvDataHeaders }
                );
                tarefasPendentes = pendenciasResponse.data.todo || 0;
                tarefasExpiradas = pendenciasResponse.data.expired || 0;
            }
        } catch (e) {
            console.error('Erro na integração IP.TV:', e.response?.data || e.message);
        }

        // ==========================================================
        // [LOG #28] CONSULTA DE AVALIAÇÕES (SED) - ID de 8 Dígitos
        // ==========================================================
        try {
            const avaliacoesResponse = await axios.get(
                `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${codigoAluno8Digitos}&AnoLetivo=2026`, 
                { headers: sedAuthHeaders }
            );
            if (Array.isArray(avaliacoesResponse.data)) {
                totalAvaliacoes = avaliacoesResponse.data.length;
            }
        } catch (e) {
            console.error('Erro na rota #28 (Avaliações):', e.response?.data || e.message);
        }

        // Envia o JSON final limpo com as informações reais capturadas
        res.json({
            aluno: {
                codigo: codigoAluno8Digitos,
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
        console.error('Erro geral no barramento principal:', error.message);
        res.status(500).json({ error: 'Erro ao processar dados no servidor administrativo.' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF Arquitetura CMSP ativa na porta ${PORT}`));
